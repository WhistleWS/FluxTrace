/**
 * cacheManager.js - 依赖图缓存管理
 * 
 * 基于 Git Commit Hash 的智能缓存机制
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class CacheManager {
    constructor(cacheDir, version = 'v3') {
        this.cacheDir = cacheDir;
        this.cacheVersion = version;
        this._commitHash = null;
    }

    /**
     * 获取当前 Git commit hash
     * @returns {string|null} commit hash 或 null
     */
    getGitCommitHash() {
        if (this._commitHash) return this._commitHash;

        try {
            this._commitHash = execSync('git rev-parse HEAD', {
                cwd: path.join(__dirname, '..'),
                encoding: 'utf-8'
            }).trim();
            return this._commitHash;
        } catch (error) {
            console.warn('⚠️ 无法获取 Git commit hash:', error.message);
            return null;
        }
    }

    /**
     * 获取缓存文件路径
     * @returns {string|null} 缓存文件路径
     */
    getCacheFilePath() {
        const commitHash = this.getGitCommitHash();
        if (!commitHash) return null;
        return path.join(this.cacheDir, `deps_${this.cacheVersion}_${commitHash}.json`);
    }

    /**
     * 检查缓存是否有效
     * @returns {boolean} 缓存是否有效
     */
    isValid() {
        const cacheFilePath = this.getCacheFilePath();
        if (!cacheFilePath) return false;
        return fs.existsSync(cacheFilePath);
    }

    /**
     * 加载缓存
     * @returns {Object|null} 缓存数据，失败返回 null
     */
    load() {
        try {
            const cacheFilePath = this.getCacheFilePath();
            if (!cacheFilePath || !fs.existsSync(cacheFilePath)) {
                return null;
            }

            const cacheData = JSON.parse(fs.readFileSync(cacheFilePath, 'utf-8'));
            console.log('🚀 从缓存加载依赖地图完成');
            return cacheData;
        } catch (error) {
            console.error('❌ 加载缓存失败:', error.message);
            return null;
        }
    }

    /**
     * 保存缓存
     * @param {Object} data - 要缓存的数据
     */
    save(data) {
        try {
            const cacheFilePath = this.getCacheFilePath();
            if (!cacheFilePath) return;

            // 确保缓存目录存在
            if (!fs.existsSync(this.cacheDir)) {
                fs.mkdirSync(this.cacheDir, { recursive: true });
            }

            const cacheData = {
                ...data,
                timestamp: Date.now()
            };

            fs.writeFileSync(cacheFilePath, JSON.stringify(cacheData, null, 2), 'utf-8');
            console.log('💾 依赖地图缓存保存完成');
        } catch (error) {
            console.error('❌ 保存缓存失败:', error.message);
        }
    }

    /**
     * 将 Map 转换为可序列化的对象
     * @param {Map} map - Map 对象
     * @returns {Object} 可序列化的对象
     */
    static mapToObject(map) {
        return Object.fromEntries(
            Array.from(map.entries()).map(([key, values]) => [key, Array.from(values)])
        );
    }

    /**
     * 将对象转换为 Map
     * @param {Object} obj - 对象
     * @returns {Map} Map 对象
     */
    static objectToMap(obj) {
        return new Map(
            Object.entries(obj).map(([key, values]) => [key, new Set(values)])
        );
    }
}

module.exports = CacheManager;
