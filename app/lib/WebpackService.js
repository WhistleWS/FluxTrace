/**
 * WebpackService.js - Webpack 依赖图服务
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🎯 核心功能：解析 Webpack 打包信息，构建组件之间的依赖关系图
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 📚 技术背景：
 *
 * 1. 什么是依赖图？
 *    当 A.vue 中写了 `import B from './B.vue'`，就形成了 A -> B 的依赖关系
 *    依赖图就是记录所有这种关系的数据结构
 *
 * 2. 为什么需要依赖图？
 *    场景：用户点击了 B 组件里的一个变量，发现它来自 props
 *    问题：谁给 B 传的 props？需要找到 B 的"父组件"
 *    解决：通过依赖图的【反向查询】找到所有引用 B 的组件
 *
 * 3. 数据来源
 *    - Webpack 打包时可以输出 stats.json，包含所有模块的依赖信息
 *    - 我们解析这个文件，构建自己的依赖图
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 📊 数据结构图解：
 *
 *   假设项目结构：
 *   ┌─────────────────────────────────────────────┐
 *   │  App.vue                                    │
 *   │    └── import Dashboard from './Dashboard'  │
 *   │                                             │
 *   │  Dashboard.vue                              │
 *   │    ├── import ChartCard from './ChartCard'  │
 *   │    └── import UserList from './UserList'    │
 *   └─────────────────────────────────────────────┘
 *
 *   正向依赖图 (forwardMap)：父 -> 子列表
 *   ┌────────────────────────────────────────────┐
 *   │  "App.vue"       -> ["Dashboard.vue"]      │
 *   │  "Dashboard.vue" -> ["ChartCard.vue",      │
 *   │                      "UserList.vue"]       │
 *   └────────────────────────────────────────────┘
 *
 *   反向依赖图 (reverseMap)：子 -> 父列表
 *   ┌────────────────────────────────────────────┐
 *   │  "Dashboard.vue" -> ["App.vue"]            │
 *   │  "ChartCard.vue" -> ["Dashboard.vue"]      │
 *   │  "UserList.vue"  -> ["Dashboard.vue"]      │
 *   └────────────────────────────────────────────┘
 *
 *   查询示例：
 *   - getChildren("App.vue")     -> ["Dashboard.vue"]
 *   - getParents("ChartCard.vue") -> ["Dashboard.vue"]
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');
const CacheManager = require('./utils/cacheManager');
const { cleanPath, tryResolveExtension, resolveRequest, isRelevantPath } = require('./utils/pathUtils');
const { resolveConfig, runCompiler } = require('./utils/webpackCompiler');

/**
 * @typedef {Object} WebpackModule
 * @property {string} [resource] - 模块的绝对路径
 * @property {string} [name] - 模块名称
 * @property {WebpackModule[]} [modules] - 子模块（Webpack5 ConcatenatedModule）
 * @property {Array<{request?: string, moduleName?: string}>} [dependencies] - 依赖列表
 * @property {Array<{moduleName?: string}>} [reasons] - 被引用原因列表
 */

class WebpackService {
  /**
   * 创建 WebpackService 实例
   * @param {Object} aliasConfig - 路径别名配置，如 { '@': 'src' }
   *
   * 📝 知识点：路径别名
   * 在 Vue 项目中，`@/components/Foo` 实际指向 `src/components/Foo`
   * Webpack 通过 resolve.alias 配置实现这个映射
   */
  constructor(aliasConfig = { '@': 'src' }) {
    /**
     * 反向依赖图：子模块 -> 父模块列表
     * 用途：找到"谁引用了我"
     * @type {Map<string, Set<string>>}
     */
    this.reverseMap = new Map();

    /**
     * 正向依赖图：父模块 -> 子模块列表
     * 用途：找到"我引用了谁"
     * @type {Map<string, Set<string>>}
     */
    this.forwardMap = new Map();

    /** 路径别名配置 */
    this.alias = aliasConfig;

    /** 项目根目录（用于路径转换） */
    this.projectRoot = process.env.PROJECT_ROOT
      ? path.resolve(process.env.PROJECT_ROOT)
      : path.resolve(__dirname, '../../..');

    /** 缓存管理器（基于 Git commit hash） */
    this.cacheManager = new CacheManager(path.join(__dirname, '.cache'));
  }

  /**
   * 初始化依赖图
   * @param {string} [statsPath] - stats.json 文件路径（降级方案）
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * 📊 初始化流程图：
   *
   *   ┌─────────────────┐
   *   │    开始初始化    │
   *   └────────┬────────┘
   *            │
   *   ┌────────▼────────┐     ┌─────────────────┐
   *   │  检查缓存是否有效 │────▶│  有效：直接加载  │──────┐
   *   └────────┬────────┘     └─────────────────┘      │
   *            │ 无效                                   │
   *   ┌────────▼────────┐     ┌─────────────────┐      │
   *   │  尝试动态编译    │────▶│  成功：构建图    │──────┤
   *   └────────┬────────┘     └─────────────────┘      │
   *            │ 失败                                   │
   *   ┌────────▼────────┐     ┌─────────────────┐      │
   *   │  读取 stats.json │────▶│  成功：构建图    │──────┤
   *   └────────┬────────┘     └─────────────────┘      │
   *            │ 失败                                   │
   *   ┌────────▼────────┐                              │
   *   │   报错退出       │                              │
   *   └─────────────────┘                              │
   *                                                    │
   *                         ┌─────────────────┐        │
   *                         │    初始化完成    │◀───────┘
   *                         └─────────────────┘
   *
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * 📝 知识点：为什么要缓存？
   *
   * stats.json 可能有几十 MB，解析很慢。
   * 我们用 Git commit hash 作为缓存 key：
   * - 代码没变 -> commit hash 没变 -> 依赖关系没变 -> 直接用缓存
   * - 代码变了 -> commit hash 变了 -> 重新构建
   */
  async init(statsPath) {
    try {
      // 清空旧数据
      this.reverseMap.clear();
      this.forwardMap.clear();

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 策略1：尝试加载缓存（最快）
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if (this.cacheManager.isValid()) {
        const cacheData = this.cacheManager.load();
        if (cacheData) {
          this.forwardMap = CacheManager.objectToMap(cacheData.forwardMap || {});
          this.reverseMap = CacheManager.objectToMap(cacheData.reverseMap || {});
          console.log(`📊 统计信息: 正向依赖 ${this.forwardMap.size}, 反向依赖 ${this.reverseMap.size}`);
          return;
        }
      }

      console.log('⚠️ 缓存失效，启动动态编译或读取 stats.json...');

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 策略2：尝试动态编译（实时性最好）
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      const config = await resolveConfig(this.projectRoot);
      if (config) {
        try {
          const modules = await runCompiler(config, this.projectRoot);
          if (modules?.length > 0) {
            this.buildGraph(modules);
            this.saveToCache();
            return;
          }
        } catch (e) {
          console.error('⚠️ 动态编译失败:', e.message);
        }
      }

      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      // 策略3：降级方案 - 读取本地 stats.json
      // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      if (statsPath && fs.existsSync(statsPath)) {
        console.log('⚠️ 降级模式：读取 stats.json');
        const stats = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
        this.buildGraph(stats.modules);
        this.saveToCache();
      }
    } catch (error) {
      console.error('❌ 依赖地图构建错误:', error.message);
    }
  }

  /**
   * 构建依赖图（核心方法）
   * @param {WebpackModule[]} modules - Webpack 模块列表
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * 📊 stats.json 模块结构示例：
   *
   *   {
   *     "modules": [
   *       {
   *         "name": "./src/views/Dashboard.vue",
   *         "resource": "/Users/xxx/project/src/views/Dashboard.vue",
   *
   *         // 我引用了谁（正向依赖）
   *         "dependencies": [
   *           { "request": "./ChartCard.vue" },
   *           { "request": "@/utils/request" }
   *         ],
   *
   *         // 谁引用了我（反向依赖）
   *         "reasons": [
   *           { "moduleName": "./src/App.vue" }
   *         ]
   *       },
   *
   *       // ⚠️ Webpack 5 的 ConcatenatedModule（嵌套结构）
   *       {
   *         "name": "ConcatenatedModule",
   *         "modules": [              // 👈 内部还有子模块
   *           { "name": "./src/utils/a.js", ... },
   *           { "name": "./src/utils/b.js", ... }
   *         ]
   *       }
   *     ]
   *   }
   *
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * 📝 知识点：ConcatenatedModule
   *
   * Webpack 5 会把多个小模块"合并"成一个大模块以优化性能。
   * 这导致 stats.json 中的模块结构变成嵌套的，需要递归处理。
   */
  buildGraph(modules) {
    console.log(`🧩 正在构建依赖图 (${modules.length} 个模块)...`);

    // 第一步：拍平嵌套模块（处理 ConcatenatedModule）
    const flatModules = this.flattenModules(modules);

    // 第二步：遍历每个模块，建立依赖关系
    flatModules.forEach(mod => {
      // 获取当前模块的路径
      const rawPath = mod.resource || mod.name;
      const currentModulePath = cleanPath(rawPath, this.projectRoot, this.alias);
      if (!currentModulePath) return;

      // 处理正向依赖：我引用了谁
      this.processForwardDependencies(mod, currentModulePath);

      // 处理反向依赖：谁引用了我
      this.processReverseDependencies(mod, currentModulePath);
    });
  }

  /**
   * 拍平嵌套的模块列表
   * @param {WebpackModule[]} modules - 可能包含嵌套的模块列表
   * @returns {WebpackModule[]} 拍平后的模块列表
   *
   * 📝 作用：将 Webpack 5 的 ConcatenatedModule 展开成扁平结构
   *
   * 示例：
   *   输入: [{ name: 'a' }, { modules: [{ name: 'b' }, { name: 'c' }] }]
   *   输出: [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
   */
  flattenModules(modules) {
    const result = [];

    modules.forEach(mod => {
      // 如果是 ConcatenatedModule，递归拍平
      if (mod.modules?.length > 0) {
        result.push(...this.flattenModules(mod.modules));
      } else {
        result.push(mod);
      }
    });

    return result;
  }

  /**
   * 处理正向依赖：当前模块引用了哪些模块
   * @param {WebpackModule} mod - 当前模块
   * @param {string} currentModulePath - 当前模块路径
   *
   * 📝 数据来源：mod.dependencies 字段
   *
   * 示例：
   *   Dashboard.vue 中写了 `import ChartCard from './ChartCard'`
   *   -> dependencies 中会有 { request: './ChartCard' }
   *   -> 建立关系：Dashboard.vue -> ChartCard.vue
   */
  processForwardDependencies(mod, currentModulePath) {
    if (!Array.isArray(mod.dependencies)) return;

    mod.dependencies.forEach(dep => {
      // 获取 import 的路径（如 './ChartCard' 或 '@/utils/request'）
      const request = dep.request || dep.moduleName;
      if (!request) return;

      // 解析相对路径，得到完整路径
      const resolved = resolveRequest(request, currentModulePath, this.alias);
      const childPath = cleanPath(resolved, this.projectRoot, this.alias);

      // 建立依赖关系：当前模块 -> 子模块
      this.linkModules(currentModulePath, childPath);
    });
  }

  /**
   * 处理反向依赖：哪些模块引用了当前模块
   * @param {WebpackModule} mod - 当前模块
   * @param {string} currentModulePath - 当前模块路径
   *
   * 📝 数据来源：mod.reasons 字段
   *
   * 示例：
   *   ChartCard.vue 的 reasons 中有 { moduleName: './src/Dashboard.vue' }
   *   -> 说明 Dashboard.vue 引用了 ChartCard.vue
   *   -> 建立关系：Dashboard.vue -> ChartCard.vue
   */
  processReverseDependencies(mod, currentModulePath) {
    if (!Array.isArray(mod.reasons)) return;

    mod.reasons.forEach(reason => {
      const parentPath = cleanPath(reason.moduleName, this.projectRoot, this.alias);
      // 建立依赖关系：父模块 -> 当前模块
      this.linkModules(parentPath, currentModulePath);
    });
  }

  /**
   * 建立父子模块的双向关联
   * @param {string} parent - 父模块路径
   * @param {string} child - 子模块路径
   *
   * 📊 图解：
   *
   *   调用 linkModules("Dashboard.vue", "ChartCard.vue") 后：
   *
   *   forwardMap (正向):              reverseMap (反向):
   *   ┌─────────────────────────┐     ┌─────────────────────────┐
   *   │ "Dashboard.vue" -> Set{ │     │ "ChartCard.vue" -> Set{ │
   *   │   "ChartCard.vue"       │     │   "Dashboard.vue"       │
   *   │ }                       │     │ }                       │
   *   └─────────────────────────┘     └─────────────────────────┘
   */
  linkModules(parent, child) {
    // 参数校验：路径必须有效且不能自己引用自己
    if (!parent || !child || parent === child) return;

    // 只处理业务代码（src/ 目录下的文件）
    if (!isRelevantPath(parent) || !isRelevantPath(child)) return;

    // 尝试补全文件后缀（如 ChartCard -> ChartCard.vue）
    const normParent = tryResolveExtension(parent, this.projectRoot);
    const normChild = tryResolveExtension(child, this.projectRoot);

    // 建立正向关系: Parent -> Child
    if (!this.forwardMap.has(normParent)) {
      this.forwardMap.set(normParent, new Set());
    }
    this.forwardMap.get(normParent).add(normChild);

    // 建立反向关系: Child -> Parent
    if (!this.reverseMap.has(normChild)) {
      this.reverseMap.set(normChild, new Set());
    }
    this.reverseMap.get(normChild).add(normParent);
  }

  /**
   * 保存依赖图到缓存
   */
  saveToCache() {
    this.cacheManager.save({
      forwardMap: CacheManager.mapToObject(this.forwardMap),
      reverseMap: CacheManager.mapToObject(this.reverseMap)
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 📦 查询接口
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * 获取引用了指定模块的所有父模块
   * @param {string} queryPath - 要查询的模块路径
   * @returns {string[]} 父模块路径列表
   *
   * 📝 使用场景：
   * 当发现某个变量来自 props，需要找到"谁给我传的 props"
   *
   * 示例：
   *   getParents("src/components/ChartCard.vue")
   *   -> ["src/views/Dashboard.vue", "src/views/Analysis.vue"]
   */
  getParents(queryPath) {
    const normalizedPath = cleanPath(queryPath, this.projectRoot, this.alias);
    const parents = this.reverseMap.get(normalizedPath);
    return parents ? Array.from(parents) : [];
  }

  /**
   * 获取指定模块引用的所有子模块
   * @param {string} queryPath - 要查询的模块路径
   * @returns {string[]} 子模块路径列表
   *
   * 📝 使用场景：
   * 分析某个组件依赖了哪些其他组件
   *
   * 示例：
   *   getChildren("src/views/Dashboard.vue")
   *   -> ["src/components/ChartCard.vue", "src/components/UserList.vue"]
   */
  getChildren(queryPath) {
    const normalizedPath = cleanPath(queryPath, this.projectRoot, this.alias);
    const children = this.forwardMap.get(normalizedPath);
    return children ? Array.from(children) : [];
  }
}

// 导出单例（整个应用共享一个依赖图实例）
module.exports = new WebpackService({ '@': 'src' });
