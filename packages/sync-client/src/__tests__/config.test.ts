import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, saveConfig, generateMachineId, getDefaultConfig } from '../config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('SyncConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'saqr-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getDefaultConfig()', () => {
    it('should return a config with sync disabled', () => {
      const config = getDefaultConfig();
      expect(config.enabled).toBe(false);
    });

    it('should have empty server URL', () => {
      const config = getDefaultConfig();
      expect(config.serverUrl).toBe('');
    });

    it('should auto-generate a machine ID', () => {
      const config = getDefaultConfig();
      expect(config.machineId).toBeTruthy();
      expect(config.machineId.length).toBeGreaterThan(0);
    });

    it('should set createdAt to current time', () => {
      const before = new Date().toISOString();
      const config = getDefaultConfig();
      const after = new Date().toISOString();

      expect(config.createdAt >= before).toBe(true);
      expect(config.createdAt <= after).toBe(true);
    });
  });

  describe('generateMachineId()', () => {
    it('should produce a deterministic ID', () => {
      const id1 = generateMachineId();
      const id2 = generateMachineId();
      expect(id1).toBe(id2);
    });

    it('should include hostname and hash', () => {
      const id = generateMachineId();
      // Format: {sanitized-hostname}-{6-hex-chars}
      expect(id).toMatch(/^[a-z0-9-]+-[a-f0-9]{6}$/);
    });
  });

  describe('loadConfig()', () => {
    it('should return defaults when no config file exists', () => {
      const config = loadConfig(tmpDir);
      expect(config.enabled).toBe(false);
      expect(config.serverUrl).toBe('');
    });

    it('should load an existing config file', () => {
      const configData = {
        enabled: true,
        serverUrl: 'https://sync.example.com',
        machineId: 'custom-machine-id',
        machineName: 'My Machine',
        authToken: 'jwt-token-here',
        createdAt: '2026-01-01T00:00:00.000Z',
      };

      fs.writeFileSync(
        path.join(tmpDir, 'sync.json'),
        JSON.stringify(configData)
      );

      const config = loadConfig(tmpDir);
      expect(config.enabled).toBe(true);
      expect(config.serverUrl).toBe('https://sync.example.com');
      expect(config.machineId).toBe('custom-machine-id');
      expect(config.authToken).toBe('jwt-token-here');
    });

    it('should merge with defaults for missing fields', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'sync.json'),
        JSON.stringify({ enabled: true })
      );

      const config = loadConfig(tmpDir);
      expect(config.enabled).toBe(true);
      // Other fields should have defaults
      expect(config.machineId).toBeTruthy();
    });

    it('should handle corrupted config file gracefully', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'sync.json'),
        'NOT VALID JSON!!!'
      );

      const config = loadConfig(tmpDir);
      expect(config.enabled).toBe(false); // Default
    });
  });

  describe('saveConfig()', () => {
    it('should write config to disk', () => {
      const config = getDefaultConfig();
      config.enabled = true;
      config.serverUrl = 'https://sync.example.com';

      saveConfig(config, tmpDir);

      const configPath = path.join(tmpDir, 'sync.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const loaded = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(loaded.enabled).toBe(true);
      expect(loaded.serverUrl).toBe('https://sync.example.com');
    });

    it('should create the config directory if it does not exist', () => {
      const nestedDir = path.join(tmpDir, 'nested', 'dir');
      const config = getDefaultConfig();

      saveConfig(config, nestedDir);

      expect(fs.existsSync(nestedDir)).toBe(true);
      expect(fs.existsSync(path.join(nestedDir, 'sync.json'))).toBe(true);
    });

    it('should overwrite existing config', () => {
      const config1 = getDefaultConfig();
      config1.serverUrl = 'https://old.example.com';
      saveConfig(config1, tmpDir);

      const config2 = getDefaultConfig();
      config2.serverUrl = 'https://new.example.com';
      saveConfig(config2, tmpDir);

      const loaded = loadConfig(tmpDir);
      expect(loaded.serverUrl).toBe('https://new.example.com');
    });

    it('should round-trip with loadConfig()', () => {
      const config = getDefaultConfig();
      config.enabled = true;
      config.serverUrl = 'https://sync.test.com';
      config.authToken = 'my-token';

      saveConfig(config, tmpDir);
      const loaded = loadConfig(tmpDir);

      expect(loaded.enabled).toBe(config.enabled);
      expect(loaded.serverUrl).toBe(config.serverUrl);
      expect(loaded.machineId).toBe(config.machineId);
      expect(loaded.authToken).toBe(config.authToken);
    });
  });
});
