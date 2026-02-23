/**
 * UsageDataAggregator - Token usage aggregation across projects/machines.
 *
 * Merges usage stats from multiple daemons, handles time-series bucketing,
 * percentage calculation, and formatting helpers.
 *
 * @module services/usage-data-aggregator
 */

import type {
  UsageStats,
  DailyUsage,
  ProjectUsage,
  ModelUsage,
} from "../types/usage.js";

/** Options for the merge operation. */
export interface MergeOptions {
  /** Maximum number of top projects before grouping remainder into "Other". */
  maxProjects?: number;
}

/**
 * Aggregates usage data from multiple daemons.
 */
export class UsageDataAggregator {
  /**
   * Merge usage stats from multiple daemons into a single view.
   */
  merge(
    statsList: UsageStats[],
    options: MergeOptions = {}
  ): UsageStats {
    const { maxProjects = Infinity } = options;

    if (statsList.length === 0) {
      return {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCost: 0,
        byDay: [],
        byProject: [],
        byModel: [],
      };
    }

    // Sum totals
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCost = 0;

    for (const stats of statsList) {
      totalInputTokens += stats.totalInputTokens;
      totalOutputTokens += stats.totalOutputTokens;
      totalCacheReadTokens += stats.totalCacheReadTokens;
      totalCost += stats.totalCost;
    }

    // Merge byDay
    const dayMap = new Map<string, DailyUsage>();
    for (const stats of statsList) {
      for (const day of stats.byDay) {
        const existing = dayMap.get(day.date);
        if (existing) {
          dayMap.set(day.date, {
            date: day.date,
            inputTokens: existing.inputTokens + day.inputTokens,
            outputTokens: existing.outputTokens + day.outputTokens,
            cacheReadTokens: existing.cacheReadTokens + day.cacheReadTokens,
            cost: existing.cost + day.cost,
            sessionCount: existing.sessionCount + day.sessionCount,
          });
        } else {
          dayMap.set(day.date, { ...day });
        }
      }
    }
    const byDay = Array.from(dayMap.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    // Merge byProject
    const projectMap = new Map<string, ProjectUsage>();
    for (const stats of statsList) {
      for (const proj of stats.byProject) {
        const existing = projectMap.get(proj.projectId);
        if (existing) {
          projectMap.set(proj.projectId, {
            ...existing,
            inputTokens: existing.inputTokens + proj.inputTokens,
            outputTokens: existing.outputTokens + proj.outputTokens,
            cost: existing.cost + proj.cost,
            sessionCount: existing.sessionCount + proj.sessionCount,
            percentage: 0, // Will recalculate
          });
        } else {
          projectMap.set(proj.projectId, { ...proj, percentage: 0 });
        }
      }
    }

    // Recalculate percentages
    let projectList = Array.from(projectMap.values());
    const projectTotalCost = projectList.reduce((sum, p) => sum + p.cost, 0);
    for (const proj of projectList) {
      proj.percentage =
        projectTotalCost > 0
          ? Math.round((proj.cost / projectTotalCost) * 100)
          : 0;
    }

    // Sort by cost descending
    projectList.sort((a, b) => b.cost - a.cost);

    // Group tail into "Other" if needed
    if (maxProjects < Infinity && projectList.length > maxProjects) {
      const top = projectList.slice(0, maxProjects);
      const rest = projectList.slice(maxProjects);

      const otherCount = rest.length;
      const otherProject: ProjectUsage = {
        projectId: "__other__",
        projectName: `Other (${otherCount} projects)`,
        inputTokens: rest.reduce((s, p) => s + p.inputTokens, 0),
        outputTokens: rest.reduce((s, p) => s + p.outputTokens, 0),
        cost: rest.reduce((s, p) => s + p.cost, 0),
        percentage:
          projectTotalCost > 0
            ? Math.round(
                (rest.reduce((s, p) => s + p.cost, 0) / projectTotalCost) *
                  100
              )
            : 0,
        sessionCount: rest.reduce((s, p) => s + p.sessionCount, 0),
      };

      projectList = [...top, otherProject];
    }

    // Merge byModel
    const modelMap = new Map<string, ModelUsage>();
    for (const stats of statsList) {
      for (const model of stats.byModel) {
        const existing = modelMap.get(model.model);
        if (existing) {
          modelMap.set(model.model, {
            ...existing,
            inputTokens: existing.inputTokens + model.inputTokens,
            outputTokens: existing.outputTokens + model.outputTokens,
            cost: existing.cost + model.cost,
            sessionCount: existing.sessionCount + model.sessionCount,
          });
        } else {
          modelMap.set(model.model, { ...model });
        }
      }
    }
    const byModel = Array.from(modelMap.values());

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCost,
      byDay,
      byProject: projectList,
      byModel,
    };
  }

  /**
   * Bucket daily usage data into weekly aggregates.
   */
  bucketByWeek(dailyData: DailyUsage[]): DailyUsage[] {
    if (dailyData.length === 0) return [];

    const sorted = [...dailyData].sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    const weeks: DailyUsage[] = [];
    let currentWeek: DailyUsage | null = null;
    let currentWeekStart = "";

    for (const day of sorted) {
      const date = new Date(day.date + "T00:00:00Z");
      const dayOfWeek = date.getUTCDay();
      // Get Monday of this week
      const monday = new Date(date);
      monday.setUTCDate(
        date.getUTCDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1)
      );
      const weekStart = monday.toISOString().slice(0, 10);

      if (weekStart !== currentWeekStart) {
        if (currentWeek) weeks.push(currentWeek);
        currentWeekStart = weekStart;
        currentWeek = {
          date: weekStart,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cost: 0,
          sessionCount: 0,
        };
      }

      if (currentWeek) {
        currentWeek.inputTokens += day.inputTokens;
        currentWeek.outputTokens += day.outputTokens;
        currentWeek.cacheReadTokens += day.cacheReadTokens;
        currentWeek.cost += day.cost;
        currentWeek.sessionCount += day.sessionCount;
      }
    }

    if (currentWeek) weeks.push(currentWeek);
    return weeks;
  }

  /**
   * Format a token count with K/M/B suffixes.
   */
  static formatTokenCount(count: number): string {
    if (count >= 1_000_000_000) {
      return `${(count / 1_000_000_000).toFixed(1)}B`;
    }
    if (count >= 1_000_000) {
      return `${(count / 1_000_000).toFixed(1)}M`;
    }
    if (count >= 1000) {
      return `${(count / 1000).toFixed(1)}K`;
    }
    return String(count);
  }

  /**
   * Format a cost as USD with 2 decimal places.
   */
  static formatCost(cost: number): string {
    return `$${cost.toFixed(2)}`;
  }
}
