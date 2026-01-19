const { findNodeInTemplate } = require('./app/lib/templateAST');
const { pruneScript } = require('./app/lib/scriptAST');
const { getUniversalVariables } = require('./app/lib/variableAST');
const webpackService = require('./app/lib/WebpackService');
const { isFromProps, findBindingInParent, findVuexDefinition, getVuexSource, findMutationTriggers } = require('./app/lib/utils/traceUtils');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = 3000;
const PROJECT_ROOT = path.resolve(__dirname, '..');
const { parseSfcTemplate, normalizeLineColumn } = require('./app/lib/sfcTemplate');

const { runAIAnalysis } = require('./app/lib/PromptService');


// 初始化 Webpack 依赖地图
const statsPath = path.resolve(PROJECT_ROOT, './stats.json');
webpackService.init(statsPath);

app.use(cors());
app.use(bodyParser.json());

app.all('/api/analyze', async (req, res) => {
    console.log('--- 收到请求 ---');

    // 使用 let 声明，允许在溯源过程中更新
    let currentRelativePath = req.query.path || req.body.path;
    let currentLine = parseInt(req.query.line);
    let currentColumn = parseInt(req.query.column);
    console.log('currentRelativePath' + currentRelativePath, 'currentLine' + currentLine, 'currentColumn' + currentColumn);

    if (!currentRelativePath) {
        return res.status(400).json({ error: '缺少文件路径' });
    }

    try {
        const traceChain = [];
        let iteration = 0;
        const MAX_DEPTH = 10;

        // 核心：用于在层级间传递“调用片段”的临时变量
        let nextCallSnippet = '';

        while (currentRelativePath && iteration < MAX_DEPTH) {
            const fullPath = path.join(PROJECT_ROOT, currentRelativePath);
            if (!fs.existsSync(fullPath)) break;

            const fileContent = fs.readFileSync(fullPath, 'utf-8');
            /**
             * 这里先把坐标规范化（把 column clamp 到本行最后一个非空白字符处）
             * 目的：避免点击落在行尾空白/换行时，column 越界导致定位“漂移到下一行节点”。
             *
             * 约定：
             * - line：1-based
             * - column：0-based
             */
            const normalized = normalizeLineColumn(fileContent, currentLine, currentColumn);
            currentLine = normalized.line;
            currentColumn = normalized.column;
            const parsed = parseSfcTemplate({
                projectRoot: PROJECT_ROOT,
                fileContent,
                filename: currentRelativePath
            });
            if (!parsed || !parsed.descriptor || !parsed.descriptor.template) break;
            // console.log('parsed===', parsed);

            // 1. 定位 Template 节点
            let targetNode = null;
            if (parsed.kind === 'vue3') {
                /**
                 * Vue3：
                 * descriptor.template.loc.start.line 是 template 在原文件中的起始行（1-based）。
                 * baseParse 生成的 AST 行号是相对 template.content 的，所以需要把 fileLine 换算到 templateLine。
                 * column 直接沿用（0-based）。
                 */
                const targetLineInTemplate = currentLine - parsed.descriptor.template.loc.start.line + 1;
                targetNode = findNodeInTemplate(parsed.templateAST, targetLineInTemplate, currentColumn);
            } else {
                /**
                 * Vue2：
                 * Vue2 的 component-compiler-utils 会对 template.content 做 de-indent，导致：
                 * - templateSource 的列坐标与原文件的列坐标不一致（少了公共缩进）
                 * - 如果仍用 “fileOffset - templateStartOffset” 做换算，会出现行/列漂移（常见表现：点 L39 变 L40）
                 *
                 * 解决：
                 * 1) 用 templateStartLoc 把 fileLine 转成 template 内的相对行号
                 * 2) 用 templateBaseIndent 把 fileColumn 转成 de-indent 后的相对列号
                 * 3) 再对 template 内的 (line,column) 做一次 clamp，然后交给 findNodeInTemplate
                 */
                const templateLine = currentLine - parsed.templateStartLoc.line + 1;
                const columnAdjusted = Math.max(0, currentColumn - (parsed.templateBaseIndent || 0));
                const templateNormalized = normalizeLineColumn(parsed.templateSource, templateLine, columnAdjusted);
                targetNode = findNodeInTemplate(parsed.templateAST, templateNormalized.line, templateNormalized.column, null, parsed.templateSource);
            }
            // console.log(`[层级 ${iteration}] 定位到节点:`, targetNode);


            if (!targetNode) break;

            // 2. 提取变量并提纯脚本
            const entryVars = getUniversalVariables(targetNode);
            console.log('提取到的变量', entryVars);

            const rawScript = parsed.descriptor.scriptSetup?.content || parsed.descriptor.script?.content || '';
            const prunedScript = pruneScript(rawScript, entryVars);

            // 3. 构建当前层级信息
            const stepInfo = {
                file: currentRelativePath,
                tag: targetNode.tag,
                prunedScript: prunedScript,
                // Vue3 用 loc.source；Vue2 用 start/end 从 templateSource 截取
                source: parsed.getNodeSource(targetNode), // 【新增】保存当前节点在模板中的原始 HTML 片段
                // 如果上一层（子组件）传来了调用片段，则存入这一层（父组件）
                callSnippet: nextCallSnippet
            };

            // 重置暂存区
            nextCallSnippet = '';

            // 4. 判定是否需要继续向上溯源
            const primaryVar = entryVars[0];
            let shouldContinue = false;

            if (primaryVar && isFromProps(rawScript, primaryVar)) {
                console.log(`[层级 ${iteration}] 发现变量 "${primaryVar}" 来自 Props，寻找父组件...`);

                const parents = webpackService.getParents(currentRelativePath);
                if (parents.length > 0) {
                    const parentRelativePath = parents[0];
                    const parentFullPath = path.resolve(PROJECT_ROOT, parentRelativePath);
                    const childClassName = path.basename(currentRelativePath, '.vue');

                    const binding = findBindingInParent(parentFullPath, childClassName, primaryVar);

                    if (binding) {
                        console.log(`  -> 成功定位父组件: ${parentRelativePath}`);

                        // 【关键逻辑】：将父组件中的 HTML 代码暂存，供下一轮循环（父组件层级）使用
                        nextCallSnippet = binding.rawTag;

                        // 更新指向父组件的信息
                        currentRelativePath = parentRelativePath;
                        currentLine = binding.line;
                        currentColumn = binding.column;
                        shouldContinue = true;
                    }
                }
            }

            // 统一入栈：每个组件仅在此处 push 一次
            traceChain.push(stepInfo);

            // 5. Vuex 数据溯源 (新增)
            // 检查 entryVars 是否包含 mapGetters 或 mapState 映射的变量
            const vuexMapping = findVuexDefinition(stepInfo.prunedScript, entryVars);
            if (vuexMapping) {
                console.log(`[层级 ${iteration}] 发现 Vuex 映射:`, vuexMapping);

                // 尝试定位 Vuex Store 定义
                const storeSource = getVuexSource(PROJECT_ROOT, vuexMapping);
                if (storeSource) {
                    console.log(`  -> 成功定位 Vuex Store: ${storeSource.file}`);

                    // 将 Store 文件加入追踪链路

                    let storeTraceContent = `// [Vuex Logic] ${vuexMapping.module}/${vuexMapping.key} (${vuexMapping.type})\n`;
                    storeTraceContent += storeSource.content + '\n\n';

                    if (storeSource.relatedState && storeSource.relatedState.length > 0) {
                        storeTraceContent += `// [Dependency] 依赖的 State: ${storeSource.relatedState.join(', ')}\n\n`;
                    }

                    if (storeSource.mutations && storeSource.mutations.length > 0) {
                        storeTraceContent += `// [Mutation] 可能修改此 State 的 Mutations (Signatures Only):\n`;
                        storeSource.mutations.forEach(m => {
                            storeTraceContent += `// -> Mutation: ${m.signature}\n`;

                            // 搜索触发此 Mutation 的代码位置
                            const triggers = findMutationTriggers(PROJECT_ROOT, m.name, vuexMapping.module);
                            if (triggers.length > 0) {
                                storeTraceContent += `//    [Trigger] 触发位置:\n`;
                                triggers.forEach(t => {
                                    storeTraceContent += `//    -> ${t.file}:${t.line}  ${t.code}\n`;
                                });
                            } else {
                                storeTraceContent += `//    (未找到显式的 commit 调用，可能是通过 mapMutations 映射调用)\n`;
                            }
                            storeTraceContent += '\n';
                        });
                    }

                    traceChain.push({
                        file: storeSource.file,
                        tag: 'Vuex Store',
                        prunedScript: storeTraceContent,
                        source: `// 来自 ${vuexMapping.module} 模块的 ${vuexMapping.key} ${vuexMapping.type}`,
                        callSnippet: ''
                    });

                    // Vuex 通常是数据源头，可以考虑在此终止或继续追踪 API 调用
                    // 暂时在此终止
                    break;
                }
            }

            if (!shouldContinue) break;
            iteration++;
        }

        // --- 构造最终返回结果 ---
        // 使用 reverse() 让 AI 从“数据源头”看到“最终渲染”
        const finalCodeForAI = traceChain.reverse().map((step) => {
            let output = `// File: ${step.file}\n`;

            // 如果此组件包含调用下级的片段，则展示 Data Flow
            if (step.callSnippet) {
                output += `// [Data Flow] 模板中调用子组件的代码:\n${step.callSnippet}\n\n`;
            }

            output += `// [Logic] 关联的脚本逻辑:\n${step.prunedScript || '// (该层级无相关脚本逻辑)'}`;
            return output;
        }).join('\n\n' + '='.repeat(25) + '\n\n');

        // 注意：reverse 之后，traceChain[traceChain.length - 1] 才是用户最开始点击的那个组件
        const finalTrace = [...traceChain].reverse();
        // 提取用户最初点击的那个 DOM 片段
        // 如果 reverse 了，就取最后一个；如果没有 reverse，就取第一个。
        // 这里建议在 reverse 之前先存下来：
        const originalTargetElement = finalTrace[0]?.source || '未知元素';

        console.log('--- 启动 AI 智能逻辑分析 ---');
        const aiAnalysis = await runAIAnalysis(finalCodeForAI, originalTargetElement, finalTrace);
        console.log('AI 分析结果:', aiAnalysis);
        res.json({
            message: '分析成功',
            targetElement: originalTargetElement,
            traceChain,    // 原始链路
            aiAnalysis,    // AI 深度分析报告
            finalCodeForAI // 提纯后的源码
        });

    } catch (err) {
        console.error('分析失败:', err);
        res.status(500).json({ error: '服务器内部错误' });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 AI Trace 后端服务已启动: http://localhost:${PORT}`);
});
