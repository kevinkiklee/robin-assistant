import { existsSync, renameSync, copyFileSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function createHelpers(workspaceDir) {
  const ud = join(workspaceDir, 'user-data');
  const scaffold = join(workspaceDir, 'system/scaffold');

  // Resolve config path: prefer the post-0022 location (runtime/), fall back
  // to post-0021 (ops/) and pre-0021 (root) for migrations that run before
  // those rename migrations have executed.
  function configPath() {
    const newP = join(ud, 'runtime/config/robin.config.json');
    if (existsSync(newP)) return newP;
    const opsP = join(ud, 'ops/config/robin.config.json');
    if (existsSync(opsP)) return opsP;
    const oldP = join(ud, 'robin.config.json');
    if (existsSync(oldP)) return oldP;
    // Default to new path for fresh writes when neither exists.
    return newP;
  }
  function readConfig() {
    return JSON.parse(readFileSync(configPath(), 'utf-8'));
  }
  function writeConfig(cfg) {
    const p = configPath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  }
  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setPath(obj, path, val) {
    const parts = path.split('.');
    const last = parts.pop();
    let cur = obj;
    for (const p of parts) {
      if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
      cur = cur[p];
    }
    cur[last] = val;
  }
  function deletePath(obj, path) {
    const parts = path.split('.');
    const last = parts.pop();
    let cur = obj;
    for (const p of parts) {
      if (cur[p] == null) return;
      cur = cur[p];
    }
    delete cur[last];
  }

  return {
    async renameFile(oldName, newName) {
      const oldPath = join(ud, oldName);
      const newPath = join(ud, newName);
      if (!existsSync(oldPath)) return; // idempotent
      mkdirSync(dirname(newPath), { recursive: true });
      renameSync(oldPath, newPath);
    },
    async removeFile(name) {
      const p = join(ud, name);
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    },
    async addFileFromScaffold(name) {
      const src = join(scaffold, name);
      const dst = join(ud, name);
      if (existsSync(dst)) return; // idempotent
      if (!existsSync(src)) throw new Error(`scaffold missing: ${name}`);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    },
    async addConfigField(jsonPath, defaultValue) {
      const cfg = readConfig();
      if (getPath(cfg, jsonPath) !== undefined) return; // idempotent
      setPath(cfg, jsonPath, defaultValue);
      writeConfig(cfg);
    },
    async renameConfigField(oldPath, newPath) {
      const cfg = readConfig();
      const val = getPath(cfg, oldPath);
      if (val === undefined) return; // idempotent
      if (getPath(cfg, newPath) !== undefined) return;
      setPath(cfg, newPath, val);
      deletePath(cfg, oldPath);
      writeConfig(cfg);
    },
    async transformFileContent(name, transformFn) {
      const p = join(ud, name);
      if (!existsSync(p)) return;
      const content = readFileSync(p, 'utf-8');
      writeFileSync(p, transformFn(content));
    },
  };
}
