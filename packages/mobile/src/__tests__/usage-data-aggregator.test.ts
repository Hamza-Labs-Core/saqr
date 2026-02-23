/**
 * Tests for the UsageDataAggregator service.
 *
 * Covers token usage aggregation across projects/machines,
 * time-series bucketing, percentage calculation, and edge cases.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { UsageDataAggregator } from "../services/usage-data-aggregator.js";
import type {
  UsageStats,
  DailyUsage,
  ProjectUsage,
  ModelUsage,
} from "../types/usage.js";

function createUsageStats(
  overrides: Partial<UsageStats> = {}
): UsageStats {
  return {
    totalInputTokens: 10000,
    totalOutputTokens: 5000,
    totalCacheReadTokens: 20000,
    totalCost: 0.5,
    byDay: [],
    byProject: [],
    byModel: [],
    ...overrides,
  };
}

function createDailyUsage(
  overrides: Partial<DailyUsage> = {}
): DailyUsage {
  return {
    date: "2026-02-22",
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 2000,
    cost: 0.05,
    sessionCount: 2,
    ...overrides,
  };
}

function createProjectUsage(
  overrides: Partial<ProjectUsage> = {}
): ProjectUsage {
  return {
    projectId: "proj-1",
    projectName: "my-project",
    inputTokens: 5000,
    outputTokens: 2500,
    cost: 0.25,
    percentage: 50,
    sessionCount: 3,
    ...overrides,
  };
}

function createModelUsage(
  overrides: Partial<ModelUsage> = {}
): ModelUsage {
  return {
    model: "claude-opus-4-6",
    inputTokens: 5000,
    outputTokens: 2500,
    cost: 0.25,
    sessionCount: 3,
    ...overrides,
  };
}

describe("UsageDataAggregator", () => {
  let aggregator: UsageDataAggregator;

  beforeEach(() => {
    aggregator = new UsageDataAggregator();
  });

  describe("merging usage from multiple daemons", () => {
    it("sums total tokens across daemons", () => {
      const stats1 = createUsageStats({
        totalInputTokens: 10000,
        totalOutputTokens: 5000,
        totalCacheReadTokens: 20000,
        totalCost: 0.5,
      });
      const stats2 = createUsageStats({
        totalInputTokens: 30000,
        totalOutputTokens: 15000,
        totalCacheReadTokens: 60000,
        totalCost: 1.5,
      });

      const merged = aggregator.merge([stats1, stats2]);
      expect(merged.totalInputTokens).toBe(40000);
      expect(merged.totalOutputTokens).toBe(20000);
      expect(merged.totalCacheReadTokens).toBe(80000);
      expect(merged.totalCost).toBe(2.0);
    });

    it("merges empty array returns zero stats", () => {
      const merged = aggregator.merge([]);
      expect(merged.totalInputTokens).toBe(0);
      expect(merged.totalOutputTokens).toBe(0);
      expect(merged.totalCost).toBe(0);
      expect(merged.byDay).toHaveLength(0);
      expect(merged.byProject).toHaveLength(0);
      expect(merged.byModel).toHaveLength(0);
    });

    it("single stats passthrough", () => {
      const stats = createUsageStats({
        totalInputTokens: 10000,
        totalCost: 0.5,
      });
      const merged = aggregator.merge([stats]);
      expect(merged.totalInputTokens).toBe(10000);
      expect(merged.totalCost).toBe(0.5);
    });
  });

  describe("daily usage aggregation", () => {
    it("groups byDay arrays by date", () => {
      const stats1 = createUsageStats({
        byDay: [
          createDailyUsage({ date: "2026-02-22", inputTokens: 1000, cost: 0.05 }),
          createDailyUsage({ date: "2026-02-21", inputTokens: 500, cost: 0.03 }),
        ],
      });
      const stats2 = createUsageStats({
        byDay: [
          createDailyUsage({ date: "2026-02-22", inputTokens: 2000, cost: 0.1 }),
          createDailyUsage({ date: "2026-02-20", inputTokens: 300, cost: 0.02 }),
        ],
      });

      const merged = aggregator.merge([stats1, stats2]);
      expect(merged.byDay).toHaveLength(3);

      const feb22 = merged.byDay.find((d) => d.date === "2026-02-22");
      expect(feb22?.inputTokens).toBe(3000);
      expect(feb22?.cost).toBeCloseTo(0.15);
    });

    it("sorts byDay by date ascending", () => {
      const stats = createUsageStats({
        byDay: [
          createDailyUsage({ date: "2026-02-22" }),
          createDailyUsage({ date: "2026-02-20" }),
          createDailyUsage({ date: "2026-02-21" }),
        ],
      });

      const merged = aggregator.merge([stats]);
      expect(merged.byDay[0].date).toBe("2026-02-20");
      expect(merged.byDay[1].date).toBe("2026-02-21");
      expect(merged.byDay[2].date).toBe("2026-02-22");
    });

    it("sums session counts per day", () => {
      const stats1 = createUsageStats({
        byDay: [createDailyUsage({ date: "2026-02-22", sessionCount: 3 })],
      });
      const stats2 = createUsageStats({
        byDay: [createDailyUsage({ date: "2026-02-22", sessionCount: 2 })],
      });

      const merged = aggregator.merge([stats1, stats2]);
      const feb22 = merged.byDay.find((d) => d.date === "2026-02-22");
      expect(feb22?.sessionCount).toBe(5);
    });
  });

  describe("project usage aggregation", () => {
    it("groups byProject by projectId", () => {
      const stats1 = createUsageStats({
        byProject: [
          createProjectUsage({
            projectId: "proj-1",
            projectName: "frontend",
            cost: 1.0,
          }),
        ],
      });
      const stats2 = createUsageStats({
        byProject: [
          createProjectUsage({
            projectId: "proj-1",
            projectName: "frontend",
            cost: 2.0,
          }),
          createProjectUsage({
            projectId: "proj-2",
            projectName: "backend",
            cost: 0.5,
          }),
        ],
      });

      const merged = aggregator.merge([stats1, stats2]);
      expect(merged.byProject).toHaveLength(2);

      const frontend = merged.byProject.find((p) => p.projectId === "proj-1");
      expect(frontend?.cost).toBe(3.0);
    });

    it("recalculates percentages after merging", () => {
      const stats1 = createUsageStats({
        totalCost: 4.0,
        byProject: [
          createProjectUsage({ projectId: "p1", cost: 3.0, percentage: 75 }),
          createProjectUsage({ projectId: "p2", cost: 1.0, percentage: 25 }),
        ],
      });
      const stats2 = createUsageStats({
        totalCost: 1.0,
        byProject: [
          createProjectUsage({ projectId: "p1", cost: 1.0, percentage: 100 }),
        ],
      });

      const merged = aggregator.merge([stats1, stats2]);
      const p1 = merged.byProject.find((p) => p.projectId === "p1");
      const p2 = merged.byProject.find((p) => p.projectId === "p2");
      // p1: 4.0/5.0 = 80%, p2: 1.0/5.0 = 20%
      expect(p1?.percentage).toBeCloseTo(80);
      expect(p2?.percentage).toBeCloseTo(20);
    });

    it("sorts byProject by cost descending", () => {
      const stats = createUsageStats({
        totalCost: 3.0,
        byProject: [
          createProjectUsage({ projectId: "p1", cost: 0.5 }),
          createProjectUsage({ projectId: "p2", cost: 2.0 }),
          createProjectUsage({ projectId: "p3", cost: 0.5 }),
        ],
      });

      const merged = aggregator.merge([stats]);
      expect(merged.byProject[0].projectId).toBe("p2");
    });

    it("groups tail projects into 'Other' when more than 5", () => {
      const projects = [];
      for (let i = 0; i < 8; i++) {
        projects.push(
          createProjectUsage({
            projectId: `p${i}`,
            projectName: `Project ${i}`,
            cost: 10 - i,
          })
        );
      }

      const stats = createUsageStats({
        totalCost: 52,
        byProject: projects,
      });

      const merged = aggregator.merge([stats], { maxProjects: 5 });
      expect(merged.byProject).toHaveLength(6); // 5 top + 1 "Other"
      const other = merged.byProject.find((p) =>
        p.projectName.startsWith("Other")
      );
      expect(other).toBeDefined();
      expect(other?.projectName).toMatch(/Other \(3 projects\)/);
    });
  });

  describe("model usage aggregation", () => {
    it("groups byModel by model name", () => {
      const stats1 = createUsageStats({
        byModel: [
          createModelUsage({ model: "claude-opus-4-6", cost: 1.0 }),
        ],
      });
      const stats2 = createUsageStats({
        byModel: [
          createModelUsage({ model: "claude-opus-4-6", cost: 2.0 }),
          createModelUsage({ model: "claude-sonnet-4-5", cost: 0.5 }),
        ],
      });

      const merged = aggregator.merge([stats1, stats2]);
      expect(merged.byModel).toHaveLength(2);

      const opus = merged.byModel.find((m) => m.model === "claude-opus-4-6");
      expect(opus?.cost).toBe(3.0);
    });

    it("sums session counts per model", () => {
      const stats1 = createUsageStats({
        byModel: [
          createModelUsage({ model: "claude-opus-4-6", sessionCount: 5 }),
        ],
      });
      const stats2 = createUsageStats({
        byModel: [
          createModelUsage({ model: "claude-opus-4-6", sessionCount: 3 }),
        ],
      });

      const merged = aggregator.merge([stats1, stats2]);
      const opus = merged.byModel.find((m) => m.model === "claude-opus-4-6");
      expect(opus?.sessionCount).toBe(8);
    });
  });

  describe("time-series bucketing", () => {
    it("bucketByWeek aggregates daily data into weekly buckets", () => {
      const dailyData: DailyUsage[] = [];
      for (let i = 1; i <= 14; i++) {
        dailyData.push(
          createDailyUsage({
            date: `2026-02-${String(i).padStart(2, "0")}`,
            inputTokens: 1000,
            cost: 0.05,
            sessionCount: 1,
          })
        );
      }

      const weekly = aggregator.bucketByWeek(dailyData);
      expect(weekly.length).toBeGreaterThanOrEqual(2);
      expect(weekly.length).toBeLessThanOrEqual(3);
    });

    it("bucketByWeek returns empty for empty input", () => {
      const weekly = aggregator.bucketByWeek([]);
      expect(weekly).toHaveLength(0);
    });
  });

  describe("formatting helpers", () => {
    it("formatTokenCount formats thousands with K suffix", () => {
      expect(UsageDataAggregator.formatTokenCount(1200)).toBe("1.2K");
      expect(UsageDataAggregator.formatTokenCount(8200)).toBe("8.2K");
    });

    it("formatTokenCount formats millions with M suffix", () => {
      expect(UsageDataAggregator.formatTokenCount(1200000)).toBe("1.2M");
    });

    it("formatTokenCount formats billions with B suffix", () => {
      expect(UsageDataAggregator.formatTokenCount(1500000000)).toBe("1.5B");
    });

    it("formatTokenCount shows raw number below 1000", () => {
      expect(UsageDataAggregator.formatTokenCount(500)).toBe("500");
      expect(UsageDataAggregator.formatTokenCount(0)).toBe("0");
    });

    it("formatCost formats USD with 2 decimal places", () => {
      expect(UsageDataAggregator.formatCost(0)).toBe("$0.00");
      expect(UsageDataAggregator.formatCost(1.234)).toBe("$1.23");
      expect(UsageDataAggregator.formatCost(47.23)).toBe("$47.23");
    });
  });

  describe("edge cases", () => {
    it("zero cost results in $0.00, not NaN", () => {
      const stats = createUsageStats({
        totalCost: 0,
        byProject: [
          createProjectUsage({ projectId: "p1", cost: 0 }),
        ],
      });
      const merged = aggregator.merge([stats]);
      expect(merged.totalCost).toBe(0);
      expect(UsageDataAggregator.formatCost(merged.totalCost)).toBe("$0.00");
    });

    it("percentage calculation avoids division by zero", () => {
      const stats = createUsageStats({
        totalCost: 0,
        byProject: [
          createProjectUsage({ projectId: "p1", cost: 0 }),
        ],
      });
      const merged = aggregator.merge([stats]);
      expect(merged.byProject[0].percentage).toBe(0);
    });
  });
});
