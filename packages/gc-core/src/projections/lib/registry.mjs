// registry.mjs -- Projection handler registry.
// Maps CLI projection names to their handlers, formatters, version numbers, and output file names.
// Each entry: { name, description, version, outputFile, handler, formatters }

// Explicit version 1 definition (M-1)
export const CURRENT_PROJECTION_VERSION = 1;

const registry = {};

/**
 * Register a projection handler.
 * @param {string} cliName - The CLI name for this projection (e.g., 'timeline')
 * @param {object} definition - { name, description, version, outputFile, handler, formatters }
 */
export function register(cliName, definition) {
  if (!definition.version) {
    definition.version = CURRENT_PROJECTION_VERSION;
  }
  registry[cliName] = definition;
}

/**
 * Get a registered projection by CLI name.
 * @returns {object|null}
 */
export function getProjection(cliName) {
  return registry[cliName] || null;
}

/**
 * List all registered projections.
 * @returns {Array<{cliName, name, description, version}>}
 */
export function listProjections() {
  return Object.entries(registry).map(([key, val]) => ({
    cliName: key,
    name: val.name,
    description: val.description,
    version: val.version,
  }));
}

/**
 * Clear all registrations (useful for testing).
 */
export function clearRegistry() {
  for (const key of Object.keys(registry)) {
    delete registry[key];
  }
}
