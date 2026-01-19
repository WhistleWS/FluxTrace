/**
 * webpackCompiler.js - Webpack 编译工具
 * 
 * 负责 Webpack 配置解析和编译器运行
 */

const fs = require('fs');
const path = require('path');

/**
 * 加载项目本地的 Webpack
 * @param {string} projectRoot - 项目根目录
 * @returns {Object} Webpack 模块
 */
function loadLocalWebpack(projectRoot) {
    try {
        return require(path.resolve(projectRoot, 'node_modules/webpack'));
    } catch (e) {
        return require('webpack');
    }
}

/**
 * 注入 Babel 插件支持 ES2020 语法（?. ??）
 * @param {Object} config - Webpack 配置
 */
function injectBabelSupport(config) {
    if (!config.module?.rules) return;

    const inject = (useEntry) => {
        if (useEntry?.loader?.includes('babel-loader')) {
            useEntry.options = useEntry.options || {};
            useEntry.options.plugins = useEntry.options.plugins || [];
            try {
                useEntry.options.plugins.push(require.resolve('@babel/plugin-proposal-optional-chaining'));
                useEntry.options.plugins.push(require.resolve('@babel/plugin-proposal-nullish-coalescing-operator'));
            } catch (e) { }
        }
    };

    const traverse = (rules) => {
        rules.forEach(rule => {
            if (Array.isArray(rule.use)) rule.use.forEach(inject);
            else if (rule.use) inject(rule.use);
            if (rule.oneOf) traverse(rule.oneOf);
        });
    };

    traverse(config.module.rules);
}

/**
 * 解析 Webpack 配置
 * @param {string} projectRoot - 项目根目录
 * @returns {Promise<Object|null>} Webpack 配置，失败返回 null
 */
async function resolveConfig(projectRoot) {
    try {
        // 1. 尝试 Vue CLI Service
        const servicePath = path.resolve(projectRoot, 'node_modules/@vue/cli-service');
        if (fs.existsSync(servicePath)) {
            const Service = require(path.resolve(servicePath, 'lib/Service'));
            const service = new Service(projectRoot);
            service.init('production');
            return service.resolveWebpackConfig();
        }

        // 2. 尝试标准 webpack.config.js
        const configPath = path.resolve(projectRoot, 'webpack.config.js');
        if (fs.existsSync(configPath)) return require(configPath);
    } catch (e) {
        console.error('❌ 解析 Webpack 配置失败:', e.message);
    }
    return null;
}

/**
 * 运行 Webpack 编译器获取模块信息
 * @param {Object} config - Webpack 配置
 * @param {string} projectRoot - 项目根目录
 * @returns {Promise<Array>} 模块列表
 */
async function runCompiler(config, projectRoot) {
    // 强制禁用 sideEffects 以获取完整依赖
    config.optimization = {
        ...config.optimization,
        sideEffects: false,
        concatenateModules: false
    };

    // 注入必要的 Babel 插件
    injectBabelSupport(config);

    return new Promise((resolve, reject) => {
        try {
            const webpack = loadLocalWebpack(projectRoot);
            const compiler = webpack(config);

            // 内存文件系统
            compiler.outputFileSystem = {
                join: path.join,
                mkdir: (p, cb) => cb(null),
                mkdirp: (p, cb) => cb(null),
                writeFile: (p, c, cb) => cb(null),
            };

            compiler.run((err, stats) => {
                if (err) return reject(err);
                const statsJson = stats.toJson({
                    source: false,
                    modules: true,
                    chunks: false,
                    assets: false
                });
                resolve(statsJson.modules);
            });
        } catch (e) {
            reject(e);
        }
    });
}

module.exports = {
    loadLocalWebpack,
    injectBabelSupport,
    resolveConfig,
    runCompiler,
};
