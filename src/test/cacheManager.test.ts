import * as assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { CacheManager } from '../cache/CacheManager';

describe('CacheManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ait-cache-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('round-trips a translation record', async () => {
    const cache = await CacheManager.open(tmpDir, 'repoA');
    cache.upsert({
      repoHash: 'repoA',
      original: '用户数量',
      translated: 'userCount',
      role: 'variable',
      script: 'zh',
      confidence: 0.9,
      model: 'ollama',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const hit = cache.lookup('repoA', '用户数量', 'variable');
    assert.strictEqual(hit?.translated, 'userCount');
    cache.dispose();
  });

  it('never returns a hit for an identifier cached under a different role', async () => {
    const cache = await CacheManager.open(tmpDir, 'repoA');
    cache.upsert({
      repoHash: 'repoA',
      original: '机器人',
      translated: 'Robot',
      role: 'class',
      script: 'zh',
      confidence: 0.9,
      model: 'ollama',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const wrongRole = cache.lookup('repoA', '机器人', 'variable');
    assert.strictEqual(wrongRole, null);
    cache.dispose();
  });

  it('isolates translations between two different repo hashes on the same DB file naming', async () => {
    const cacheA = await CacheManager.open(tmpDir, 'repoA');
    const cacheB = await CacheManager.open(tmpDir, 'repoB');

    cacheA.upsert({
      repoHash: 'repoA',
      original: '计数',
      translated: 'count',
      role: 'variable',
      script: 'zh',
      confidence: 0.9,
      model: 'ollama',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    assert.strictEqual(cacheB.lookup('repoB', '计数', 'variable'), null);
    cacheA.dispose();
    cacheB.dispose();
  });

  it('never returns a stale fallback (confidence 0) entry as a cache hit', async () => {
    // Regression test: a fallback translation (Ollama unreachable/bad JSON)
    // must not permanently block future retries once Ollama starts working.
    const cache = await CacheManager.open(tmpDir, 'repoA');
    cache.upsert({
      repoHash: 'repoA',
      original: '设置',
      translated: 'id_a1b2c3',
      role: 'function',
      script: 'zh',
      confidence: 0.0,
      model: 'fallback',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    assert.strictEqual(cache.lookup('repoA', '设置', 'function'), null);
    assert.strictEqual(cache.lookupMany('repoA', ['设置']).size, 0);
    cache.dispose();
  });

  it('never returns a high-confidence but non-English cached "translation" as a hit', async () => {
    // Regression test: entries written before the English-only validation
    // existed (e.g. a small model paraphrasing Arabic back into Arabic,
    // cached with confidence 0.85 as if it were a real success) must not
    // resurface forever just because their confidence was high at write time.
    const cache = await CacheManager.open(tmpDir, 'repoA');
    cache.upsert({
      repoHash: 'repoA',
      original: 'مدير_الإعدادات',
      translated: 'مدير_الإعدادات', // model paraphrased back into Arabic, not English
      role: 'class',
      script: 'ar',
      confidence: 0.85,
      model: 'ollama',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    assert.strictEqual(cache.lookup('repoA', 'مدير_الإعدادات', 'class'), null);
    assert.strictEqual(cache.lookupMany('repoA', ['مدير_الإعدادات']).size, 0);
    cache.dispose();
  });

  it('clearRepo only removes entries for that repo hash', async () => {
    const cache = await CacheManager.open(tmpDir, 'repoA');
    cache.upsert({
      repoHash: 'repoA',
      original: 'x',
      translated: 'y',
      role: 'variable',
      script: 'zh',
      confidence: 0.9,
      model: 'ollama',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const removed = cache.clearRepo('repoA');
    assert.strictEqual(removed, 1);
    assert.strictEqual(cache.lookup('repoA', 'x', 'variable'), null);
    cache.dispose();
  });
});
