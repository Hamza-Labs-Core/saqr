/**
 * EU Data Residency — Art. 44-49 GDPR transfer restrictions.
 *
 * Detects user region from Cloudflare headers and enforces EU data
 * residency for EU users by adding location hints to DO and R2 operations.
 */

// ---------------------------------------------------------------------------
// EU Country Codes (EU + EEA)
// ---------------------------------------------------------------------------

export const EU_COUNTRY_CODES = new Set([
  // EU member states
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  // EEA countries
  'IS', 'LI', 'NO',
  // UK (adequate decision, treat as EU for data residency)
  'GB',
]);

// ---------------------------------------------------------------------------
// Region Detection
// ---------------------------------------------------------------------------

export type UserRegion = 'eu' | 'non-eu' | 'unknown';

export interface RegionInfo {
  region: UserRegion;
  countryCode: string | null;
  isEU: boolean;
}

/**
 * Detect the user's region from Cloudflare request headers.
 *
 * @param request - The incoming request
 * @returns Region information
 */
export function getUserRegion(request: Request): RegionInfo {
  const countryCode = request.headers.get('CF-IPCountry');

  if (!countryCode || countryCode === 'XX' || countryCode === 'T1') {
    return {
      region: 'unknown',
      countryCode: null,
      isEU: false,
    };
  }

  const isEU = EU_COUNTRY_CODES.has(countryCode.toUpperCase());

  return {
    region: isEU ? 'eu' : 'non-eu',
    countryCode: countryCode.toUpperCase(),
    isEU,
  };
}

// ---------------------------------------------------------------------------
// Location Hints
// ---------------------------------------------------------------------------

export interface LocationHint {
  locationHint: 'weur' | 'eeur' | 'apac' | 'wnam' | 'enam';
}

/**
 * Get the Cloudflare location hint for a given region.
 * EU users get Western Europe (weur) as the default hint.
 */
export function getLocationHint(regionInfo: RegionInfo): LocationHint {
  if (regionInfo.isEU) {
    return { locationHint: 'weur' };
  }

  // Eastern Europe but not EU
  if (regionInfo.countryCode && ['UA', 'MD', 'BY', 'GE', 'AM', 'AZ'].includes(regionInfo.countryCode)) {
    return { locationHint: 'eeur' };
  }

  // Default to wnam for unknown/non-EU
  return { locationHint: 'wnam' };
}

// ---------------------------------------------------------------------------
// Residency Enforcement Middleware
// ---------------------------------------------------------------------------

export interface ResidencyContext {
  regionInfo: RegionInfo;
  locationHint: LocationHint;
  enforceEU: boolean;
}

/**
 * Enforce EU data residency for EU users.
 *
 * Returns residency context that should be attached to DO/R2 operations
 * so data stays within the appropriate jurisdiction.
 *
 * @param request - The incoming request
 * @returns Residency context for downstream operations
 */
export function enforceEUResidency(request: Request): ResidencyContext {
  const regionInfo = getUserRegion(request);
  const locationHint = getLocationHint(regionInfo);

  return {
    regionInfo,
    locationHint,
    enforceEU: regionInfo.isEU,
  };
}

/**
 * Add residency headers to a response for client transparency.
 */
export function addResidencyHeaders(
  response: Response,
  context: ResidencyContext,
): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Data-Region', context.regionInfo.region);

  if (context.regionInfo.countryCode) {
    headers.set('X-Detected-Country', context.regionInfo.countryCode);
  }

  if (context.enforceEU) {
    headers.set('X-EU-Residency', 'enforced');
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
