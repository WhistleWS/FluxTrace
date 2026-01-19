/**
 * astUtils.js - AST 处理工具函数库
 * 
 * 提供通用的 AST 处理工具函数，避免代码重复
 */

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const { VUE_RENDER_HELPERS, BUILT_IN_IDENTIFIERS } = require('./astConfig');

/**
 * 判断节点是否为 Vue3 AST 节点
 * @param {Object} node - AST 节点
 * @returns {boolean} 是否为 Vue3 节点
 */
function isVue3Node(node) {
    return !!(node && node.loc);
}

/**
 * 判断标识符是否为内置函数或 Vue Helper
 * @param {string} name - 标识符名称
 * @returns {boolean} 是否为内置或 Helper
 */
function isBuiltInOrHelper(name) {
    return BUILT_IN_IDENTIFIERS.has(name) || VUE_RENDER_HELPERS.has(name);
}

/**
 * 从表达式中提取所有标识符（变量名）
 * @param {string} expression - 表达式字符串
 * @returns {string[]} 提取的标识符列表
 * 
 * 使用 Babel 解析表达式，精准提取业务变量，过滤：
 * - Vue 渲染 Helper（_s, _c, ...）
 * - 成员表达式的属性名（item.user.avatar 中的 user、avatar）
 * - 对象字面量的 key（{foo: 1} 中的 foo）
 */
function extractIdentifiers(expression) {
    if (typeof expression !== 'string' || !expression.trim()) {
        return [];
    }

    try {
        const ast = parser.parse(`(${expression})`, {
            sourceType: 'module',
            plugins: [
                'optionalChaining',
                'nullishCoalescingOperator',
                'objectRestSpread',
                'dynamicImport',
                'classProperties',
                'decorators-legacy'
            ]
        });

        const identifiers = new Set();

        traverse(ast, {
            Identifier(path) {
                const name = path.node.name;
                if (!name) return;

                // 过滤 Vue Helper 和内置标识符
                if (isBuiltInOrHelper(name)) return;

                const parent = path.parent;
                if (!parent) {
                    identifiers.add(name);
                    return;
                }

                // 过滤成员表达式的属性名（非计算属性）
                // 例如：item.user.avatar 中的 user、avatar
                if (parent.type === 'MemberExpression' &&
                    parent.property === path.node &&
                    !parent.computed) {
                    return;
                }

                // 过滤可选链的属性名
                if (parent.type === 'OptionalMemberExpression' &&
                    parent.property === path.node &&
                    !parent.computed) {
                    return;
                }

                // 过滤对象属性的 key（非计算属性）
                if (parent.type === 'ObjectProperty' &&
                    parent.key === path.node &&
                    !parent.computed) {
                    return;
                }

                // 过滤对象方法的 key
                if (parent.type === 'ObjectMethod' &&
                    parent.key === path.node &&
                    !parent.computed) {
                    return;
                }

                identifiers.add(name);
            }
        });

        return Array.from(identifiers);
    } catch (err) {
        // Babel 解析失败时，回退到正则表达式
        const regex = /\b(?!(?:true|false|null|if|else|for|in|of|this|undefined)\b)[a-zA-Z_$][\w$]*/g;
        const matches = expression.match(regex) || [];
        return matches.filter((id) => !isBuiltInOrHelper(id));
    }
}

/**
 * 生成 AST 节点的代码
 * @param {Object} node - AST 节点
 * @returns {string} 生成的代码字符串
 */
function generateCode(node) {
    return generate(node).code;
}

/**
 * 解析 Babel AST
 * @param {string} code - 源代码
 * @param {Object} options - 解析选项
 * @returns {Object} AST 对象
 */
function parseCode(code, options = {}) {
    return parser.parse(code, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx'],
        ...options
    });
}

/**
 * 遍历 AST
 * @param {Object} ast - AST 对象
 * @param {Object} visitors - 访问者对象
 */
function traverseAST(ast, visitors) {
    return traverse(ast, visitors);
}

/**
 * 判断变量名是否应该被保留
 * @param {string} varName - 变量名
 * @param {Set} visitedVars - 已访问的变量集合
 * @param {string} code - 代码片段
 * @returns {boolean} 是否应该保留
 */
function shouldKeepVariable(varName, visitedVars, code) {
    // 检查变量是否在已访问集合中
    if (visitedVars.has(varName)) return true;

    // 检查代码片段是否包含任何已访问的变量
    return Array.from(visitedVars).some(v =>
        !BUILT_IN_IDENTIFIERS.has(v) && code.includes(v)
    );
}

module.exports = {
    isVue3Node,
    isBuiltInOrHelper,
    extractIdentifiers,
    generateCode,
    parseCode,
    traverseAST,
    shouldKeepVariable
};
