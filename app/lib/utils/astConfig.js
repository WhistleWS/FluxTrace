/**
 * astConfig.js - AST 处理配置中心
 * 
 * 集中管理所有 AST 处理过程中的配置项，包括：
 * - 黑名单/白名单
 * - Vue 内置函数
 * - 保留的生命周期钩子
 * - Import 过滤规则
 */

// Vue 渲染 Helper 函数（编译器注入的辅助函数，需要过滤）
const VUE_RENDER_HELPERS = new Set([
    '_c',  // createElement
    '_o',  // markOnce
    '_n',  // toNumber
    '_s',  // toString
    '_l',  // renderList
    '_t',  // renderSlot
    '_q',  // looseEqual
    '_i',  // looseIndexOf
    '_m',  // renderStatic
    '_f',  // resolveFilter
    '_k',  // checkKeyCodes
    '_b',  // bindObjectProps
    '_v',  // createTextVNode
    '_e',  // createEmptyVNode
    '_u',  // resolveScopedSlots
    '_g',  // bindObjectListeners
    '_d',  // bindDynamicKeys
    '_p'   // prependModifier
]);

// JavaScript 内置对象和常用全局变量（不需要追踪的变量）
const BUILT_IN_IDENTIFIERS = new Set([
    // 基础类型构造函数
    'String', 'Number', 'Boolean', 'Array', 'Object', 'Date', 'Math',
    'RegExp', 'Function', 'Symbol', 'Promise', 'Set', 'Map',

    // 常用全局对象
    'console', 'window', 'document', 'JSON',

    // 常用关键字
    'undefined', 'null', 'true', 'false', 'this',

    // 控制流关键字（虽然不会被识别为 Identifier，但作为兜底）
    'if', 'else', 'for', 'in', 'of', 'while', 'return'
]);

// Script 提纯时的变量黑名单（通常是回调参数，不需要深入追踪）
const SCRIPT_VARIABLE_BLACKLIST = new Set([
    'res',      // 接口响应
    'data',     // 通用数据
    'item',     // v-for 中的临时变量
    'index',    // 索引
    'e',        // 事件对象
    'event',    // 事件对象
    'err',      // 错误对象
    'error',    // 错误对象
    'require'   // CommonJS require
]);

// Script 提纯时需要过滤掉的 Vue 组件属性（不影响数据流分析）
const FILTERED_COMPONENT_PROPERTIES = new Set([
    'components',  // 子组件注册
    'i18n',        // 国际化
    'directives',  // 自定义指令
    'filters',     // 过滤器
    'mixins'       // 混入
]);

// Script 提纯时必须保留的 Vue 组件属性
const PRESERVED_COMPONENT_PROPERTIES = new Set([
    'name',        // 组件名
    'props',       // 属性
    'data',        // 数据
    'computed',    // 计算属性
    'methods',     // 方法
    'watch',       // 侦听器
    'created',     // 生命周期钩子
    'mounted'      // 生命周期钩子
]);

// 需要过滤但不属于业务逻辑的通用变量名
const GENERIC_VARIABLE_NAMES = new Set([
    'String', 'Number', 'Boolean', 'Array', 'Object',
    'res', 'data', 'METHOD', 'request'
]);

// Import 语句保留规则：包含这些关键字的 import 会被保留
const PRESERVED_IMPORT_KEYWORDS = [
    'vuex',      // 状态管理
    'request',   // 接口请求工具
    'api',       // API 定义
    'store'      // 数据仓库
];

module.exports = {
    VUE_RENDER_HELPERS,
    BUILT_IN_IDENTIFIERS,
    SCRIPT_VARIABLE_BLACKLIST,
    FILTERED_COMPONENT_PROPERTIES,
    PRESERVED_COMPONENT_PROPERTIES,
    GENERIC_VARIABLE_NAMES,
    PRESERVED_IMPORT_KEYWORDS
};
