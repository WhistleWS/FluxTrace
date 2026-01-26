const fs = require('fs');
const path = require('path');
const { parse } = require('@vue/compiler-sfc');
const { baseParse } = require('@vue/compiler-core');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

/**
 * 迁移/修复说明：
 * - getVuexSource 内部使用了 path.join/path.relative 但原文件未引入 path，
 *   在 Egg 环境中一旦触发 Vuex 溯源就会抛 ReferenceError: path is not defined。
 * - 这里补齐 Node.js 内置模块 path 的引用，属于稳定性修复，不改变业务逻辑。
 */

function isFromProps(scriptCode, varName) {
    try {
        const ast = parser.parse(scriptCode, { sourceType: 'module', plugins: ['typescript', 'jsx', 'classProperties', 'decorators-legacy'] });
        let isProp = false;
        traverse(ast, {
            ObjectProperty(path) {
                if (path.node.key.name === 'props') {
                    const value = path.node.value;
                    if (value.type === 'ArrayExpression') {
                        isProp = value.elements.some(e => e.value === varName);
                    } else if (value.type === 'ObjectExpression') {
                        isProp = value.properties.some(p => p.key && p.key.name === varName);
                    }
                }
            }
        });
        return isProp;
    } catch (e) { return false; }
}

/**
 * 识别代码中是否使用了 mapGetters 或 mapState
 * 并返回对应的模块和 key
 */
function findVuexDefinition(scriptCode, varNames) {
    try {
        const ast = parser.parse(scriptCode, { sourceType: 'module', plugins: ['typescript', 'jsx', 'classProperties', 'decorators-legacy'] });
        let result = null;
        
        traverse(ast, {
            CallExpression(path) {
                // 检查是否是 mapGetters('module', ['key']) 或 mapState(...)
                const calleeName = path.node.callee.name;
                if (calleeName === 'mapGetters' || calleeName === 'mapState') {
                    const args = path.node.arguments;
                    let namespace = null;
                    let mapObj = null;

                    if (args.length === 1) {
                         // mapGetters(['key'])
                         mapObj = args[0];
                    } else if (args.length === 2) {
                         // mapGetters('namespace', ['key'])
                         if (args[0].type === 'StringLiteral') {
                             namespace = args[0].value;
                         }
                         mapObj = args[1];
                    }

                    if (mapObj) {
                        if (mapObj.type === 'ArrayExpression') {
                            // ['key1', 'key2']
                            mapObj.elements.forEach(el => {
                                if (el.type === 'StringLiteral' && varNames.includes(el.value)) {
                                    result = {
                                        type: calleeName === 'mapGetters' ? 'getter' : 'state',
                                        module: namespace,
                                        key: el.value
                                    };
                                }
                            });
                        } else if (mapObj.type === 'ObjectExpression') {
                            // { alias: 'key' }
                            mapObj.properties.forEach(prop => {
                                if (prop.key.name && varNames.includes(prop.key.name)) {
                                     // 如果是对象形式，value 可能是字符串也可能是函数
                                     // 这里简化处理，假设是字符串映射
                                     if (prop.value.type === 'StringLiteral') {
                                         result = {
                                            type: calleeName === 'mapGetters' ? 'getter' : 'state',
                                            module: namespace,
                                            key: prop.value.value
                                         };
                                     }
                                }
                            });
                        }
                    }
                }
            }
        });
        return result;
    } catch (e) { 
        console.error('Vuex analysis failed:', e.message);
        return null; 
    }
}

/**
 * 增强版 Vuex Store 分析
 * 1. 提取 getter 源码
 * 2. 分析 getter 依赖了哪些 state
 * 3. 找到修改这些 state 的 mutations
 */
function analyzeVuexStore(content, type, key) {
    try {
        const ast = parser.parse(content, { sourceType: 'module', plugins: ['typescript', 'jsx', 'classProperties', 'decorators-legacy', 'objectRestSpread'] });
        let result = {
            source: '',
            relatedState: [],
            mutations: []
        };
        
        // 辅助：查找 mutations 对象
        let mutationsNode = null;
        let stateNode = null;
        
        traverse(ast, {
            ObjectProperty(path) {
                // 找到 mutations: { ... }
                if (path.node.key.name === 'mutations' && path.node.value.type === 'ObjectExpression') {
                    mutationsNode = path.node.value;
                }
                 // 找到 state: { ... }
                if (path.node.key.name === 'state' && path.node.value.type === 'ObjectExpression') {
                    stateNode = path.node.value;
                }
            }
        });

        if (type === 'getter') {
            traverse(ast, {
                ObjectProperty(path) {
                    // 找到 getters: { ... }
                    if (path.node.key.name === 'getters' && path.node.value.type === 'ObjectExpression') {
                        // 在 getters 对象中找目标函数
                        path.node.value.properties.forEach(prop => {
                            if (prop.key.name === key) {
                                // 1. 提取源码 (简单截取)
                                const start = prop.loc.start.line;
                                const end = prop.loc.end.line;
                                const lines = content.split('\n');
                                result.source = lines.slice(start - 1, end).join('\n');
                                
                                // 2. 分析依赖 state
                                // 假设 getter 第一个参数是 state
                                // 简单遍历函数体 AST
                                // 这里需要构建一个小型的 AST 遍历，只针对这个函数节点
                                const getterBody = prop.value || prop; // prop.value 是函数体
                                // 手动遍历一下函数体找 state.xxx
                                // 这里为了简单，我们用正则或者简单的递归访问
                                // TODO: 使用 traverse 遍历子节点更稳健
                                
                                // 简单正则匹配 state.xxx
                                const bodyCode = result.source;
                                const stateMatches = bodyCode.match(/state\.(\w+)/g);
                                if (stateMatches) {
                                    stateMatches.forEach(match => {
                                        const stateName = match.split('.')[1];
                                        if (!result.relatedState.includes(stateName)) {
                                            result.relatedState.push(stateName);
                                        }
                                    });
                                }
                            }
                        });
                    }
                }
            });
        } else if (type === 'state') {
            result.relatedState.push(key);
            // 提取 state 定义源码
            if (stateNode) {
                 stateNode.properties.forEach(prop => {
                     if (prop.key.name === key) {
                         const start = prop.loc.start.line;
                         const end = prop.loc.end.line;
                         const lines = content.split('\n');
                         result.source = lines.slice(start - 1, end).join('\n');
                     }
                 });
            }
        }
        
        // 3. 查找修改了这些 state 的 mutations
        if (mutationsNode && result.relatedState.length > 0) {
            mutationsNode.properties.forEach(mutation => {
                const mutationName = mutation.key.name;
                const start = mutation.loc.start.line;
                const end = mutation.loc.end.line;
                const lines = content.split('\n');
                const mutationCode = lines.slice(start - 1, end).join('\n');
                
                // 检查代码中是否有 state.xxx = ...
                // 简单字符串匹配
                let isRelated = false;
                result.relatedState.forEach(s => {
                    if (mutationCode.includes(`state.${s} =`) || mutationCode.includes(`state.${s}=`)) {
                        isRelated = true;
                    }
                });
                
                if (isRelated) {
                    // 提取函数签名
                    let params = [];
                    if (mutation.type === 'ObjectMethod') {
                        params = mutation.params;
                    } else if (mutation.type === 'ObjectProperty') {
                        if (mutation.value.type === 'FunctionExpression' || mutation.value.type === 'ArrowFunctionExpression') {
                            params = mutation.value.params;
                        }
                    }
                    
                    const paramNames = params.map(p => {
                        if (p.type === 'Identifier') return p.name;
                        if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') return p.left.name;
                        if (p.type === 'RestElement' && p.argument.type === 'Identifier') return '...' + p.argument.name;
                        return 'arg';
                    });
                    
                    const signature = `${mutationName}(${paramNames.join(', ')})`;

                    result.mutations.push({
                        name: mutationName,
                        signature: signature
                    });
                }
            });
        }

        return result;
    } catch (e) {
        console.error('Analyze Vuex store failed:', e);
        return { source: content, relatedState: [], mutations: [] };
    }
}

/**
 * 定位 Vuex Store 文件并提取相关代码
 */
function getVuexSource(projectRoot, vuexInfo) {
    // 假设标准目录结构 src/store/modules/[module].js
    // 或者 src/store/index.js
    
    let targetFile = '';
    if (vuexInfo.module) {
        targetFile = path.join(projectRoot, 'src/store/modules', `${vuexInfo.module}.js`);
        if (!fs.existsSync(targetFile)) {
             // 尝试 index.js
             targetFile = path.join(projectRoot, 'src/store/modules', vuexInfo.module, 'index.js');
        }
    } else {
        targetFile = path.join(projectRoot, 'src/store/index.js');
    }

    if (fs.existsSync(targetFile)) {
        const content = fs.readFileSync(targetFile, 'utf-8');
        // 使用新版分析函数
        const analysis = analyzeVuexStore(content, vuexInfo.type, vuexInfo.key);
        
        return {
            file: path.relative(projectRoot, targetFile),
            content: analysis.source,
            relatedState: analysis.relatedState,
            mutations: analysis.mutations
        };
    }
    return null;
}

function findBindingInParent(parentFullPath, childClassName, propName, sfcCache = null) {
    let content, descriptor, templateAST;

    // 🆕 优先使用缓存
    if (sfcCache && sfcCache.has(parentFullPath)) {
        const cached = sfcCache.get(parentFullPath);
        content = cached.fileContent;
        descriptor = cached.parsed.descriptor;
        templateAST = cached.parsed.templateAST;
    } else {
        // 缓存未命中：解析文件
        content = fs.readFileSync(parentFullPath, 'utf-8');
        const parseResult = parse(content);
        descriptor = parseResult.descriptor;
        if (!descriptor.template) return null;
        templateAST = baseParse(descriptor.template.content);

        // 🆕 写入缓存供后续使用
        if (sfcCache) {
            sfcCache.set(parentFullPath, {
                parsed: {
                    descriptor,
                    templateAST,
                    kind: 'vue3',
                    getNodeSource: (node) => node.loc?.source || '',
                },
                fileContent: content,
            });
        }
    }

    if (!descriptor.template) return null;

    const templateStartLine = descriptor.template.loc.start.line;
    const kebabChildTag = childClassName.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();

    let binding = null;
    function walk(node) {
        if (binding) return;
        if (node.type === 1 && (node.tag === childClassName || node.tag === kebabChildTag)) {
            const foundProp = node.props.find(p => {
                if (p.type === 6) return p.name === propName;
                if (p.type === 7) return p.arg?.content === propName || (p.name === 'bind' && p.arg?.content === propName);
                return false;
            });

            if (foundProp) {
                binding = {
                    variable: foundProp.exp ? foundProp.exp.content : (foundProp.value ? foundProp.value.content : ''),
                    line: foundProp.loc.start.line + templateStartLine - 1,
                    column: foundProp.loc.start.column,
                    rawTag: node.loc.source  // 抓取父组件里的调用 HTML 片段
                };
            }
        }
        if (node.children) node.children.forEach(walk);
    }
    walk(templateAST);
    return binding;
}

const { execSync } = require('child_process');

/**
 * 搜索项目代码，查找触发特定 Mutation 的位置
 * 策略：使用 grep 搜索 commit('mutationName') 或 commit('module/mutationName')
 */
function findMutationTriggers(projectRoot, mutationName, moduleName) {
    try {
        const triggers = [];
        
        // 构造搜索关键词
        // 1. 完整命名空间: commit('setting/setMenuData')
        // 2. 局部命名空间 (在 module 内部): commit('setMenuData')
        // 3. 映射形式: ...mapMutations(['setMenuData']) -> this.setMenuData()
        
        // 我们主要搜索 commit 字符串
        const searchPatterns = [
            `commit\\(['"]${moduleName}/${mutationName}['"]`, // commit('module/name')
            `commit\\(['"]${mutationName}['"]`,               // commit('name')
            // 对于 mapMutations 比较难直接 grep，暂时忽略或只搜 mutationName
        ];
        
        // 使用 ripgrep (rg) 或 grep
        // 优先搜 commit 调用
        // 注意转义：grep 需要转义括号
        
        // 简单起见，我们搜索 mutationName 字符串，然后由 AI 二次过滤
        // 但为了性能，还是精确一点
        
        const pattern = `commit\\(['\\"](${moduleName}/)?${mutationName}['\\"]`;
        
        // 执行 grep 命令
        // -r: 递归
        // -n: 显示行号
        // -i: 忽略大小写
        // --include: 只搜 js/vue/ts
        // 拆分 include 以避免 shell 扩展问题
        const includes = ['js', 'vue', 'ts', 'jsx', 'tsx']
            .map(ext => `--include="*.${ext}"`)
            .join(' ');
            
        const cmd = `grep -r -n -E "${pattern}" "${projectRoot}/src" ${includes}`;
        
        try {
            const stdout = execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
            if (stdout) {
                stdout.split('\n').filter(Boolean).forEach(line => {
                    const [file, lineNum, ...codeParts] = line.split(':');
                    const code = codeParts.join(':').trim();
                    
                    // 过滤掉 Store 定义本身
                    if (!file.includes(`store/modules/${moduleName}`)) {
                        const triggerInfo = {
                            file: path.relative(projectRoot, file),
                            line: parseInt(lineNum),
                            code: code,
                            snippet: '' // 待补充上下文
                        };
                        
                        // 尝试提取上下文，判断是否是在某个组件的方法中
                        // 这里可以读取文件内容，简单往上找 method 定义
                        // 或者直接把文件名作为线索
                        
                        triggers.push(triggerInfo);
                    }
                });
            }
        } catch (e) {
            // grep 返回非 0 表示没找到，忽略
        }
        
        return triggers;
    } catch (e) {
        console.error('Find mutation triggers failed:', e);
        return [];
    }
}

module.exports = { isFromProps, findBindingInParent, findVuexDefinition, getVuexSource, findMutationTriggers };
