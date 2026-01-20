/**
 * FluxTrace Webpack 插件
 * 自动注入 FluxTrace 监听脚本到 HTML 中
 */

class FluxTracePlugin {
  constructor(options = {}) {
    this.options = {
      port: 3000,
      host: 'localhost',
      silent: false,
      ...options
    };
  }

  apply(compiler) {
    const { port, host, silent } = this.options;
    const baseUrl = `http://${host}:${port}`;

    compiler.hooks.compilation.tap('FluxTracePlugin', (compilation) => {
      // 尝试获取 HtmlWebpackPlugin 钩子
      let HtmlWebpackPlugin;
      try {
        HtmlWebpackPlugin = require('html-webpack-plugin');
      } catch (e) {
        console.warn('[FluxTracePlugin] html-webpack-plugin 未安装，跳过 HTML 注入');
        return;
      }

      if (HtmlWebpackPlugin.getHooks) {
        HtmlWebpackPlugin.getHooks(compilation).beforeEmit.tapAsync(
          'FluxTracePlugin',
          (data, cb) => {
            const script = `
    <script>
      (function() {
        if (typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'production') return;
        if (window.__FLUX_TRACE_INITIALIZED__) return;
        window.__FLUX_TRACE_INITIALIZED__ = true;
        window.addEventListener('code-inspector:trackCode', function(e) {
          var d = e.detail || {};
          if (!d.path) return;
          ${silent ? '' : "console.log('📡 FluxTrace: 分析 ' + d.path + ':' + d.line + ':' + d.column);"}
          fetch('${baseUrl}/api/analyze?path=' + encodeURIComponent(d.path) + '&line=' + d.line + '&column=' + d.column)
            .then(function(r) { return r.json(); })
            .then(function(result) { ${silent ? '' : "console.log('✅ FluxTrace 分析完成:', result);"} })
            .catch(function(err) { ${silent ? '' : "console.error('❌ FluxTrace 请求失败:', err);"} });
        });
        ${silent ? '' : "console.log('🔧 FluxTrace SDK 已初始化 (via Webpack Plugin)');"}
      })();
    </script>
`;
            data.html = data.html.replace('</body>', script + '</body>');
            cb(null, data);
          }
        );
      }
    });
  }
}

/**
 * 创建 FluxTrace 插件集合
 * 同时配置 code-inspector-plugin 和 FluxTracePlugin
 *
 * @param {Object} options - 配置选项
 * @param {number} options.port - FluxTrace 后端端口，默认 3000
 * @param {string} options.host - FluxTrace 后端主机，默认 'localhost'
 * @param {boolean} options.silent - 是否静默模式，默认 false
 * @param {Object} options.codeInspector - code-inspector-plugin 额外配置
 * @returns {Array} Webpack 插件数组
 */
function createFluxTracePlugins(options = {}) {
  const { codeInspector = {}, ...fluxTraceOptions } = options;

  let CodeInspectorPlugin;
  try {
    const codeInspectorModule = require('code-inspector-plugin');
    CodeInspectorPlugin = codeInspectorModule.CodeInspectorPlugin || codeInspectorModule.codeInspectorPlugin;
  } catch (e) {
    console.warn('[createFluxTracePlugins] code-inspector-plugin 未安装');
    return [new FluxTracePlugin(fluxTraceOptions)];
  }

  const codeInspectorConfig = {
    bundler: 'webpack',
    showSwitch: false,
    behavior: {
      locate: false,  // 禁用默认的打开编辑器行为
      copy: false
    },
    ...codeInspector
  };

  return [
    CodeInspectorPlugin(codeInspectorConfig),
    new FluxTracePlugin(fluxTraceOptions)
  ];
}

// 重新导出 code-inspector-plugin，方便外部直接使用
let codeInspectorPlugin;
try {
  const codeInspectorModule = require('code-inspector-plugin');
  codeInspectorPlugin = codeInspectorModule.codeInspectorPlugin || codeInspectorModule.CodeInspectorPlugin;
} catch (e) {
  codeInspectorPlugin = null;
}

module.exports = { FluxTracePlugin, createFluxTracePlugins, codeInspectorPlugin };
