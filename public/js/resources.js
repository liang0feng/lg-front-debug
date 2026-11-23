/* 模型 / 工具 / 智能体：三层缓存（内存 → localStorage → 网络）。
 * 刷新 = 强制网络，失败保留旧缓存；清空 = 先删缓存再拉取，以新结果为准。
 */

import { clearResCache, loadResCache, resCacheKey, saveResCache } from './store.js';

const MAX_AGE = 10 * 60 * 1000;

function emptySlot() {
  return { items: [], fetchedAt: 0, source: '', error: null };
}

export class ResourceManager {
  constructor({ api, getCfg, onChange }) {
    this.api = api;
    this.getCfg = getCfg;
    this.onChange = onChange || function () {};
    this.state = {
      models: emptySlot(),
      tools: emptySlot(),
      agents: emptySlot(),
      loading: false,
      lastError: '',
      loadedKey: '',
    };
    this._inflight = null;
  }

  key() {
    return resCacheKey(this.getCfg());
  }

  /** 从 localStorage 恢复（切换配置后也会调用）。 */
  hydrate() {
    const key = this.key();
    if (key === this.state.loadedKey) return this.state;
    const rec = loadResCache(key);
    this.state = {
      models: rec && rec.models ? Object.assign(emptySlot(), rec.models) : emptySlot(),
      tools: rec && rec.tools ? Object.assign(emptySlot(), rec.tools) : emptySlot(),
      agents: rec && rec.agents ? Object.assign(emptySlot(), rec.agents) : emptySlot(),
      loading: false,
      lastError: '',
      loadedKey: key,
    };
    // 缓存项统一标注来源
    ['models', 'tools', 'agents'].forEach((k) => {
      if (this.state[k].fetchedAt) this.state[k].source = 'cache';
    });
    this.onChange(this.state);
    return this.state;
  }

  hasAny() {
    return ['models', 'tools', 'agents'].some((k) => this.state[k].items.length > 0);
  }

  isStale() {
    const times = ['models', 'tools', 'agents']
      .map((k) => this.state[k].fetchedAt)
      .filter(Boolean);
    if (!times.length) return true;
    return Date.now() - Math.max.apply(null, times) > MAX_AGE;
  }

  _persist() {
    const key = this.state.loadedKey || this.key();
    const pick = (s) => ({
      items: s.items,
      fetchedAt: s.fetchedAt,
      source: s.source,
      error: s.error,
    });
    saveResCache(key, {
      schema: 1,
      models: pick(this.state.models),
      tools: pick(this.state.tools),
      agents: pick(this.state.agents),
    });
  }

  /**
   * @param {object} opts
   * @param {boolean} [opts.force] 忽略新鲜度，强制走网络
   * @param {boolean} [opts.silent] 不触发 loading 态（后台静默刷新）
   */
  async load(opts = {}) {
    this.hydrate();
    if (!opts.force && !this.isStale() && this.hasAny()) return this.state;
    if (this._inflight) return this._inflight;

    const keyAtStart = this.key();
    this.state.loading = true;
    this.state.lastError = '';
    this.onChange(this.state);

    this._inflight = (async () => {
      try {
        await this.api.ensureToken();
      } catch (e) {
        this.state.loading = false;
        this.state.lastError = e.message || '获取令牌失败';
        ['models', 'tools', 'agents'].forEach((k) => {
          this.state[k].error = { code: e.code || 'TOKEN', message: e.message || '' };
        });
        this.onChange(this.state);
        return this.state;
      }

      const jobs = [
        this._fetchOne('models', async () => {
          const { data } = await this.api.request('GET', '/work/openapi/v1/models', { retry: false });
          return Array.isArray(data) ? data : [];
        }),
        this._fetchOne('tools', async () => {
          const { data } = await this.api.request('GET', '/work/openapi/v1/tools', {
            query: { page: 1, pageSize: 100 },
            retry: false,
          });
          return (data && data.records) || [];
        }),
        this._fetchOne('agents', async () => {
          const { data } = await this.api.request('GET', '/work/openapi/v1/agents', {
            query: { page: 1, pageSize: 100 },
            retry: false,
          });
          return (data && data.records) || [];
        }),
      ];
      await Promise.all(jobs);

      // 环境在请求期间被切换：丢弃结果，重新按新环境水合
      if (this.key() !== keyAtStart) {
        this._inflight = null;
        this.state.loading = false;
        return this.hydrate();
      }

      this.state.loading = false;
      const errors = ['models', 'tools', 'agents']
        .map((k) => this.state[k].error)
        .filter(Boolean);
      this.state.lastError = errors.length
        ? errors.map((e) => (e.code ? '[' + e.code + '] ' : '') + e.message).join('；')
        : '';
      this._persist();
      this.onChange(this.state);
      return this.state;
    })().finally(() => {
      this._inflight = null;
    });

    return this._inflight;
  }

  async _fetchOne(name, fn) {
    const slot = this.state[name];
    try {
      const items = await fn();
      slot.items = items;
      slot.fetchedAt = Date.now();
      slot.source = 'network';
      slot.error = null;
    } catch (e) {
      // 失败不覆盖旧数据，只记录错误
      slot.error = { code: e.code || 'HTTP', message: e.message || '加载失败' };
      if (!slot.fetchedAt) slot.source = '';
    }
    this.onChange(this.state);
  }

  /** 清空缓存并重新拉取；新结果（含空结果）为准，失败不回退旧数据。 */
  async clearAndReload() {
    const key = this.key();
    clearResCache(key);
    this.state.models = emptySlot();
    this.state.tools = emptySlot();
    this.state.agents = emptySlot();
    this.state.loadedKey = key;
    this.onChange(this.state);
    return this.load({ force: true });
  }

  summary() {
    const s = this.state;
    return {
      models: s.models.items.length,
      tools: s.tools.items.length,
      agents: s.agents.items.length,
      loading: s.loading,
      error: s.lastError,
    };
  }
}