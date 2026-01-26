/**
 * variableAST.js - Vue 模板变量提取工具
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🎯 核心功能：从 Vue 模板 AST 节点中提取所有绑定的变量，并按三个维度分类
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 📚 三维度变量分类：
 *
 * 1. 内容变量（Content Variables）
 *    - 来源：{{ }} 插值表达式
 *    - 示例：{{ userName }}、{{ formatDate(createTime) }}
 *
 * 2. 属性变量（Attribute Variables）
 *    - 来源：:prop、v-bind、v-model、@event 等动态绑定
 *    - 示例：:class="activeClass"、@click="handleClick"
 *
 * 3. 条件变量（Conditional Variables）
 *    - 来源：v-if、v-else-if、v-show 条件指令
 *    - 示例：v-if="isVisible && hasPermission"
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 📊 输出结构示例：
 *
 *   {
 *     content: [
 *       { name: 'userName', expression: 'userName', raw: '{{ userName }}' }
 *     ],
 *     attributes: [
 *       { name: 'activeClass', directive: ':class', expression: 'activeClass' }
 *     ],
 *     conditionals: [
 *       { directive: 'v-if', expression: 'isVisible', variables: ['isVisible'] }
 *     ],
 *     all: ['userName', 'activeClass', 'isVisible']  // 扁平列表，向后兼容
 *   }
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 📊 v-for 别名溯源：
 *
 *   v-for 会创建临时变量（别名），这些变量本身没有意义，
 *   我们需要溯源到真正的数据源。
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  <div v-for="item in userList">                           │
 *   │    {{ item.name }}                                        │
 *   │  </div>                                                   │
 *   └────────────────────────────────────────────────────────────┘
 *
 *   提取过程：
 *   1. 发现变量 item
 *   2. 检测到 item 是 v-for 的别名
 *   3. 溯源到真正的数据源：userList
 *   4. 最终返回：['userList']（而不是 ['item']）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { isVue3Node, extractIdentifiers } = require('./utils/astUtils');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 常量定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 条件指令列表
 * 这些指令控制元素的显示/隐藏
 */
const CONDITIONAL_DIRECTIVES = ['v-if', 'v-else-if', 'v-show'];

/**
 * 条件指令名称（Vue3 格式，不带 v- 前缀）
 */
const CONDITIONAL_DIRECTIVE_NAMES_VUE3 = ['if', 'else-if', 'show'];

/**
 * 从节点属性中提取变量
 * @param {Object} node - AST 节点
 * @param {boolean} isVue3 - 是否为 Vue3 节点
 * @returns {Set<string>} 提取的变量集合
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 📝 Vue 模板中的动态绑定类型
 *
 * ┌─────────────────────┬────────────────────────────────────────────┐
 * │  语法               │  说明                                      │
 * ├─────────────────────┼────────────────────────────────────────────┤
 * │  :prop="value"      │  v-bind 简写，绑定属性                     │
 * │  v-bind:prop="val"  │  v-bind 完整写法                           │
 * │  @event="handler"   │  v-on 简写，绑定事件                       │
 * │  v-on:event="fn"    │  v-on 完整写法                             │
 * │  v-model="data"     │  双向绑定                                  │
 * │  v-if="condition"   │  条件渲染                                  │
 * │  v-for="item in ls" │  列表渲染（需要特殊处理）                  │
 * └─────────────────────┴────────────────────────────────────────────┘
 *
 * 📊 Vue2 vs Vue3 属性存储差异：
 *
 *   Vue2: node.attrsList = [{ name: ':class', value: 'activeClass' }]
 *   Vue3: node.props = [{ name: 'bind', exp: { content: 'activeClass' } }]
 * ═══════════════════════════════════════════════════════════════════════════
 */
function extractFromProps(node, isVue3) {
    const identifiers = new Set();

    if (isVue3) {
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // Vue3：动态属性/指令表达式在 prop.exp.content
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        if (node.props) {
            node.props.forEach(prop => {
                // exp 是表达式对象，content 是表达式字符串
                if (prop.exp?.content) {
                    extractIdentifiers(prop.exp.content).forEach(id => identifiers.add(id));
                }
            });
        }
    } else {
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        // Vue2：动态表达式在 attrsList.value
        // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        if (node.attrsList) {
            node.attrsList.forEach(attr => {
                if (!attr || typeof attr.name !== 'string') return;

                const { name, value } = attr;

                // 判断是否为动态绑定（以 : @ v- 开头）
                const isDynamic =
                    name.startsWith(':') ||        // :class="xxx"
                    name.startsWith('v-bind:') ||  // v-bind:class="xxx"
                    name.startsWith('@') ||        // @click="xxx"
                    name.startsWith('v-on:') ||    // v-on:click="xxx"
                    name.startsWith('v-');         // v-model, v-if 等

                if (!isDynamic || !value) return;

                // v-for 特殊处理：只提取数据源，不提取别名
                if (name === 'v-for') {
                    // "item in userList" -> 提取 "userList"
                    // "(item, index) in userList" -> 提取 "userList"
                    const parts = value.split(/\s+(?:in|of)\s+/);
                    const sourceExpr = parts.length > 1 ? parts[parts.length - 1] : value;
                    extractIdentifiers(sourceExpr).forEach(id => identifiers.add(id));
                    return;
                }

                // 其他指令：直接提取表达式中的变量
                extractIdentifiers(value).forEach(id => identifiers.add(id));
            });
        }
    }

    return identifiers;
}

/**
 * 从子节点中提取变量（主要是插值表达式）
 * @param {Object} node - AST 节点
 * @param {boolean} isVue3 - 是否为 Vue3 节点
 * @returns {Set<string>} 提取的变量集合
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 📝 插值表达式 {{ }}
 *
 * 插值表达式是 Vue 模板中最常见的数据绑定方式。
 * 它会被编译成特殊的子节点类型。
 *
 * 📊 Vue2 vs Vue3 插值节点差异：
 *
 *   Vue2: { type: 2, expression: "userName" }
 *   Vue3: { type: 5, content: { content: "userName" } }
 *
 * 📊 示例：
 *
 *   模板：<span>{{ userName }}</span>
 *
 *   Vue2 AST:
 *   {
 *     tag: 'span',
 *     children: [{
 *       type: 2,              // 表达式文本节点
 *       expression: 'userName'
 *     }]
 *   }
 *
 *   Vue3 AST:
 *   {
 *     tag: 'span',
 *     children: [{
 *       type: 5,              // Interpolation 类型
 *       content: { content: 'userName' }
 *     }]
 *   }
 * ═══════════════════════════════════════════════════════════════════════════
 */
function extractFromChildren(node, isVue3) {
    const identifiers = new Set();

    if (!node.children) return identifiers;

    node.children.forEach(child => {
        if (isVue3) {
            // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            // Vue3：type 5 表示 Interpolation（插值表达式）
            // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            if (child.type === 5) {
                const expression = child.content?.content || child.content;
                if (typeof expression === 'string') {
                    extractIdentifiers(expression).forEach(id => identifiers.add(id));
                }
            }
        } else {
            // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            // Vue2：type 2 表示表达式文本节点
            // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            if (child && child.type === 2 && typeof child.expression === 'string') {
                extractIdentifiers(child.expression).forEach(id => identifiers.add(id));
            }
        }
    });

    return identifiers;
}

/**
 * 应用兜底策略：向上查找 v-for 数据源
 * @param {Object} node - 当前节点
 * @returns {Set<string>} 找到的变量集合
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 📝 兜底策略的使用场景
 *
 * 当用户点击一个纯静态节点时（如 <div>9小时前</div>），
 * 节点本身没有动态绑定，但它可能位于 v-for 循环内部。
 *
 * 这时我们向上查找父节点，看是否有 v-for，
 * 如果有，就返回 v-for 的数据源。
 *
 * 📊 示例：
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  <div v-for="item in activities">   <- 有 v-for           │
 *   │    <span>{{ item.title }}</span>                          │
 *   │    <span>9小时前</span>             <- 用户点击这里       │
 *   │  </div>                                                   │
 *   └────────────────────────────────────────────────────────────┘
 *
 *   点击 "9小时前"：
 *   1. 节点本身没有变量
 *   2. 向上查找，发现父节点有 v-for="item in activities"
 *   3. 返回：['activities']
 *
 * 📝 注意：当前实现中这个函数暂未启用
 * ═══════════════════════════════════════════════════════════════════════════
 */
function applyFallbackStrategy(node) {
    const identifiers = new Set();
    let current = node;

    // 向上遍历父节点链
    while (current) {
        // Vue2：v-for 的数据源存储在 current.for 字段
        if (current.for && typeof current.for === 'string') {
            extractIdentifiers(current.for).forEach(id => identifiers.add(id));
            break;
        }
        current = current.parent;
    }

    return identifiers;
}

/**
 * 溯源变量：将 v-for 别名转换为真实数据源
 * @param {Object} node - 当前节点
 * @param {string} name - 变量名
 * @returns {string} 溯源后的变量名
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 📝 v-for 别名溯源
 *
 * v-for 会创建临时变量（别名），如 item、index。
 * 这些变量只在循环作用域内有效，追踪它们没有意义。
 * 我们需要找到真正的数据源。
 *
 * 📊 示例：
 *
 *   v-for="(item, index) in activities"
 *
 *   别名列表：
 *   - item：循环项
 *   - index：索引
 *
 *   数据源：activities
 *
 *   调用示例：
 *   - resolveVariableSource(node, 'item')  -> 'activities'
 *   - resolveVariableSource(node, 'index') -> 'activities'
 *   - resolveVariableSource(node, 'other') -> 'other'（不是别名，原样返回）
 *
 * 📊 Vue2 vs Vue3 v-for 解析结果差异：
 *
 *   Vue2：
 *   {
 *     for: 'activities',    // 数据源
 *     alias: 'item',        // 循环项别名
 *     iterator1: 'index',   // 第一个迭代器（索引）
 *     iterator2: undefined  // 第二个迭代器（用于对象遍历时的 key）
 *   }
 *
 *   Vue3：
 *   {
 *     props: [{
 *       name: 'for',
 *       forParseResult: {
 *         source: { content: 'activities' },
 *         value: { content: 'item' },
 *         key: { content: 'index' }
 *       }
 *     }]
 *   }
 * ═══════════════════════════════════════════════════════════════════════════
 */
function resolveVariableSource(node, name) {
    let current = node;

    // 向上遍历父节点链，查找 v-for
    while (current) {
        const isVue3 = isVue3Node(current);

        if (isVue3) {
            // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            // Vue3：v-for 解析结果在 props[].forParseResult
            // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            const vFor = current.props?.find(p => p.name === 'for');
            if (vFor?.forParseResult) {
                const { value, source } = vFor.forParseResult;
                // 如果当前变量是 v-for 的别名，返回数据源
                if (value?.content === name) {
                    return source.content;
                }
            }
        } else {
            // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            // Vue2：v-for 解析后会生成 alias、iterator1、iterator2、for 字段
            // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            if (current.for) {
                const { alias, iterator1, iterator2 } = current;
                // 如果当前变量是别名或迭代器，返回数据源
                if (name === alias || name === iterator1 || name === iterator2) {
                    return current.for;
                }
            }
        }

        current = current.parent;
    }

    // 不是 v-for 别名，返回原变量名
    return name;
}

/**
 * 从 Vue 模板 AST 节点中提取所有变量
 * @param {Object} node - AST 节点
 * @returns {string[]} 提取并溯源后的变量列表
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🎯 这是对外暴露的唯一接口
 *
 * 输入：一个 Vue 模板 AST 节点
 * 输出：该节点绑定的所有变量名（已做 v-for 别名溯源）
 *
 * 📊 处理流程：
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  输入: AST 节点                                             │
 *   │  <div :class="activeClass">{{ item.name }}</div>           │
 *   └─────────────────────────────────────────────────────────────┘
 *                           │
 *                           ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Step 1: 从属性中提取变量                                   │
 *   │  :class="activeClass" -> ['activeClass']                   │
 *   └─────────────────────────────────────────────────────────────┘
 *                           │
 *                           ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Step 2: 从子节点（插值）中提取变量                         │
 *   │  {{ item.name }} -> ['item']                               │
 *   └─────────────────────────────────────────────────────────────┘
 *                           │
 *                           ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Step 3: v-for 别名溯源                                     │
 *   │  'item' -> 'userList'（如果 item 是 v-for 别名）           │
 *   └─────────────────────────────────────────────────────────────┘
 *                           │
 *                           ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  输出: ['activeClass', 'userList']                         │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * 📝 关于静态内容：
 *
 * 如果节点没有任何动态绑定（如 <span>Alipay</span>），
 * 即使它在 v-for 循环内，也会返回空数组。
 * 这样 AI 才能正确识别出这是静态内容。
 * ═══════════════════════════════════════════════════════════════════════════
 */
function getUniversalVariables(node) {
    if (!node) return [];

    // 判断 AST 版本
    const isVue3 = isVue3Node(node);

    // 收集原始变量名
    const rawIdentifiers = new Set();

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 1: 从属性中提取变量
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 包括 :prop、@event、v-model、v-if 等
    extractFromProps(node, isVue3).forEach(id => rawIdentifiers.add(id));

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 2: 从子节点中提取变量
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 主要是 {{ }} 插值表达式
    extractFromChildren(node, isVue3).forEach(id => rawIdentifiers.add(id));

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Step 3: 对所有变量进行 v-for 别名溯源
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 把 item、index 等临时变量转换为真正的数据源
    const finalVars = new Set();
    rawIdentifiers.forEach(id => {
        const source = resolveVariableSource(node, id);
        finalVars.add(source);
    });

    // 📝 注意：移除了兜底策略
    // 如果节点本身没有动态绑定（如 <span>Alipay</span>），
    // 即使它在 v-for 循环内，也应该返回空数组
    // 这样 AI 才能正确识别出这是静态内容

    return Array.from(finalVars);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 三维度变量分类提取函数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 提取内容变量（{{ }} 插值表达式中的变量）
 * @param {Object} node - AST 节点
 * @param {boolean} isVue3 - 是否为 Vue3 节点
 * @returns {Array} 内容变量列表
 *
 * 📊 返回结构：
 *   [{ name: 'userName', expression: 'userName | capitalize', raw: '{{ userName | capitalize }}' }]
 */
function extractContentVariables(node, isVue3) {
    const contentVars = [];

    if (!node.children) return contentVars;

    node.children.forEach(child => {
        if (isVue3) {
            // Vue3：type 5 表示 Interpolation（插值表达式）
            if (child.type === 5) {
                const expression = child.content?.content || child.content;
                if (typeof expression === 'string') {
                    const variables = extractIdentifiers(expression);
                    // 对每个变量进行 v-for 别名溯源
                    const resolvedVars = variables.map(v => resolveVariableSource(node, v));

                    contentVars.push({
                        expression: expression,
                        raw: `{{ ${expression} }}`,
                        variables: [...new Set(resolvedVars)]
                    });
                }
            }
        } else {
            // Vue2：type 2 表示表达式文本节点
            if (child && child.type === 2 && typeof child.expression === 'string') {
                const expression = child.expression;
                const variables = extractIdentifiers(expression);
                // 对每个变量进行 v-for 别名溯源
                const resolvedVars = variables.map(v => resolveVariableSource(node, v));

                // 尝试还原原始模板文本
                const rawText = child.text || `{{ ${expression} }}`;

                contentVars.push({
                    expression: expression,
                    raw: rawText,
                    variables: [...new Set(resolvedVars)]
                });
            }
        }
    });

    return contentVars;
}

/**
 * 提取属性变量（:prop、v-bind、v-model、@event 中的变量）
 * @param {Object} node - AST 节点
 * @param {boolean} isVue3 - 是否为 Vue3 节点
 * @returns {Array} 属性变量列表
 *
 * 📊 返回结构：
 *   [{ name: 'disabled', directive: ':disabled', expression: '!canEdit', variables: ['canEdit'] }]
 */
function extractAttributeVariables(node, isVue3) {
    const attrVars = [];

    if (isVue3) {
        // Vue3：动态属性在 node.props
        if (node.props) {
            node.props.forEach(prop => {
                // 跳过条件指令（v-if、v-show 等），它们在 conditionals 中处理
                if (CONDITIONAL_DIRECTIVE_NAMES_VUE3.includes(prop.name)) return;
                // 跳过 v-for
                if (prop.name === 'for') return;

                if (prop.exp?.content) {
                    const expression = prop.exp.content;
                    const variables = extractIdentifiers(expression);
                    const resolvedVars = variables.map(v => resolveVariableSource(node, v));

                    // 构建指令名称
                    let directive = '';
                    if (prop.name === 'bind') {
                        directive = `:${prop.arg?.content || 'unknown'}`;
                    } else if (prop.name === 'on') {
                        directive = `@${prop.arg?.content || 'unknown'}`;
                    } else if (prop.name === 'model') {
                        directive = 'v-model';
                    } else {
                        directive = `v-${prop.name}`;
                    }

                    attrVars.push({
                        directive: directive,
                        expression: expression,
                        variables: [...new Set(resolvedVars)]
                    });
                }
            });
        }
    } else {
        // Vue2：动态属性在 node.attrsList
        if (node.attrsList) {
            node.attrsList.forEach(attr => {
                if (!attr || typeof attr.name !== 'string') return;

                const { name, value } = attr;

                // 跳过条件指令
                if (CONDITIONAL_DIRECTIVES.includes(name)) return;
                // 跳过 v-for
                if (name === 'v-for') return;
                // 跳过静态属性
                if (!value) return;

                // 判断是否为动态绑定
                const isDynamic =
                    name.startsWith(':') ||
                    name.startsWith('v-bind:') ||
                    name.startsWith('@') ||
                    name.startsWith('v-on:') ||
                    name === 'v-model' ||
                    (name.startsWith('v-') && !CONDITIONAL_DIRECTIVES.includes(name));

                if (!isDynamic) return;

                const variables = extractIdentifiers(value);
                const resolvedVars = variables.map(v => resolveVariableSource(node, v));

                attrVars.push({
                    directive: name,
                    expression: value,
                    variables: [...new Set(resolvedVars)]
                });
            });
        }
    }

    return attrVars;
}

/**
 * 提取条件变量（v-if、v-else-if、v-show 中的变量）
 * @param {Object} node - AST 节点
 * @param {boolean} isVue3 - 是否为 Vue3 节点
 * @returns {Array} 条件变量列表
 *
 * 📊 返回结构：
 *   [{
 *     directive: 'v-if',
 *     expression: 'isLogin && hasRole',
 *     variables: ['isLogin', 'hasRole']
 *   }]
 */
function extractConditionalVariables(node, isVue3) {
    const conditionalVars = [];

    if (isVue3) {
        // Vue3：条件指令在 node.props
        if (node.props) {
            node.props.forEach(prop => {
                // 检查是否为条件指令
                if (CONDITIONAL_DIRECTIVE_NAMES_VUE3.includes(prop.name)) {
                    if (prop.exp?.content) {
                        const expression = prop.exp.content;
                        const variables = extractIdentifiers(expression);
                        const resolvedVars = variables.map(v => resolveVariableSource(node, v));

                        conditionalVars.push({
                            directive: `v-${prop.name}`,
                            expression: expression,
                            variables: [...new Set(resolvedVars)]
                        });
                    }
                }
            });
        }
    } else {
        // Vue2：条件指令在 node.attrsList
        if (node.attrsList) {
            node.attrsList.forEach(attr => {
                if (!attr || typeof attr.name !== 'string') return;

                const { name, value } = attr;

                // 检查是否为条件指令
                if (CONDITIONAL_DIRECTIVES.includes(name) && value) {
                    const variables = extractIdentifiers(value);
                    const resolvedVars = variables.map(v => resolveVariableSource(node, v));

                    conditionalVars.push({
                        directive: name,
                        expression: value,
                        variables: [...new Set(resolvedVars)]
                    });
                }
            });
        }

        // Vue2 还需要检查节点上的 if/elseif 属性（编译后的结果）
        if (node.if && node.ifConditions) {
            node.ifConditions.forEach(cond => {
                if (cond.exp) {
                    const expression = cond.exp;
                    const variables = extractIdentifiers(expression);
                    const resolvedVars = variables.map(v => resolveVariableSource(node, v));

                    // 避免重复添加
                    const exists = conditionalVars.some(cv => cv.expression === expression);
                    if (!exists) {
                        conditionalVars.push({
                            directive: 'v-if',
                            expression: expression,
                            variables: [...new Set(resolvedVars)]
                        });
                    }
                }
            });
        }
    }

    return conditionalVars;
}

/**
 * 获取分类后的变量（三维度分析）
 * @param {Object} node - AST 节点
 * @returns {Object} 分类后的变量对象
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🎯 这是新的主要对外接口，返回三维度分类的变量
 *
 * 📊 返回结构：
 *   {
 *     content: [{ expression, raw, variables }],
 *     attributes: [{ directive, expression, variables }],
 *     conditionals: [{ directive, expression, variables }],
 *     all: ['var1', 'var2', ...]  // 扁平列表，向后兼容
 *   }
 * ═══════════════════════════════════════════════════════════════════════════
 */
function getCategorizedVariables(node) {
    if (!node) {
        return {
            content: [],
            attributes: [],
            conditionals: [],
            all: []
        };
    }

    // 判断 AST 版本
    const isVue3 = isVue3Node(node);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 分别提取三类变量
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const content = extractContentVariables(node, isVue3);
    const attributes = extractAttributeVariables(node, isVue3);
    const conditionals = extractConditionalVariables(node, isVue3);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 汇总所有变量（去重），用于向后兼容
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const allVarsSet = new Set();

    content.forEach(item => {
        item.variables.forEach(v => allVarsSet.add(v));
    });
    attributes.forEach(item => {
        item.variables.forEach(v => allVarsSet.add(v));
    });
    conditionals.forEach(item => {
        item.variables.forEach(v => allVarsSet.add(v));
    });

    return {
        content,
        attributes,
        conditionals,
        all: Array.from(allVarsSet)
    };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 模块导出
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

module.exports = {
    getUniversalVariables,
    getCategorizedVariables,
    // 以下函数也导出，方便单元测试
    extractContentVariables,
    extractAttributeVariables,
    extractConditionalVariables
};
