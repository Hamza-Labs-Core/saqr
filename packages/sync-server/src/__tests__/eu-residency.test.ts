/**
 * Tests for EU Data Residency — Art. 44-49 GDPR transfer restrictions.
 *
 * Covers:
 * - EU country detection from CF-IPCountry header
 * - Location hints for DO and R2 operations
 * - Residency enforcement for EU users
 * - Unknown/missing country handling
 * - Residency headers on responses
 */

import { describe, it, expect } from 'vitest';
import {
  getUserRegion,
  enforceEUResidency,
  addResidencyHeaders,
  getLocationHint,
  EU_COUNTRY_CODES,
} from '../middleware/eu-residency.js';

function createRequestWithCountry(countryCode: string | null): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (countryCode !== null) {
    headers['CF-IPCountry'] = countryCode;
  }
  return new Request('https://sync.test.dev/api/sync/push', { headers });
}

describe('EU Data Residency', () => {
  // -----------------------------------------------------------------------
  // getUserRegion
  // -----------------------------------------------------------------------

  describe('getUserRegion', () => {
    it('should detect EU countries', () => {
      const euCountries = ['DE', 'FR', 'IT', 'ES', 'NL', 'PL', 'SE', 'AT', 'BE'];
      for (const code of euCountries) {
        const request = createRequestWithCountry(code);
        const region = getUserRegion(request);
        expect(region.isEU).toBe(true);
        expect(region.region).toBe('eu');
        expect(region.countryCode).toBe(code);
      }
    });

    it('should detect EEA countries as EU', () => {
      const eeaCountries = ['IS', 'LI', 'NO'];
      for (const code of eeaCountries) {
        const request = createRequestWithCountry(code);
        const region = getUserRegion(request);
        expect(region.isEU).toBe(true);
      }
    });

    it('should treat UK as EU (adequacy decision)', () => {
      const request = createRequestWithCountry('GB');
      const region = getUserRegion(request);
      expect(region.isEU).toBe(true);
    });

    it('should detect non-EU countries', () => {
      const nonEuCountries = ['US', 'CA', 'AU', 'JP', 'BR', 'IN'];
      for (const code of nonEuCountries) {
        const request = createRequestWithCountry(code);
        const region = getUserRegion(request);
        expect(region.isEU).toBe(false);
        expect(region.region).toBe('non-eu');
        expect(region.countryCode).toBe(code);
      }
    });

    it('should return unknown when CF-IPCountry header is missing', () => {
      const request = createRequestWithCountry(null);
      const region = getUserRegion(request);
      expect(region.region).toBe('unknown');
      expect(region.countryCode).toBeNull();
      expect(region.isEU).toBe(false);
    });

    it('should return unknown for special CF-IPCountry values', () => {
      // XX = unknown, T1 = Tor
      for (const code of ['XX', 'T1']) {
        const request = createRequestWithCountry(code);
        const region = getUserRegion(request);
        expect(region.region).toBe('unknown');
        expect(region.countryCode).toBeNull();
      }
    });

    it('should handle lowercase country codes', () => {
      const request = createRequestWithCountry('de');
      const region = getUserRegion(request);
      expect(region.isEU).toBe(true);
      expect(region.countryCode).toBe('DE');
    });
  });

  // -----------------------------------------------------------------------
  // getLocationHint
  // -----------------------------------------------------------------------

  describe('getLocationHint', () => {
    it('should return weur for EU users', () => {
      const regionInfo = {
        region: 'eu' as const,
        countryCode: 'DE',
        isEU: true,
      };
      const hint = getLocationHint(regionInfo);
      expect(hint.locationHint).toBe('weur');
    });

    it('should return wnam for non-EU users', () => {
      const regionInfo = {
        region: 'non-eu' as const,
        countryCode: 'US',
        isEU: false,
      };
      const hint = getLocationHint(regionInfo);
      expect(hint.locationHint).toBe('wnam');
    });

    it('should return eeur for Eastern European non-EU countries', () => {
      const regionInfo = {
        region: 'non-eu' as const,
        countryCode: 'UA',
        isEU: false,
      };
      const hint = getLocationHint(regionInfo);
      expect(hint.locationHint).toBe('eeur');
    });

    it('should return wnam for unknown region', () => {
      const regionInfo = {
        region: 'unknown' as const,
        countryCode: null,
        isEU: false,
      };
      const hint = getLocationHint(regionInfo);
      expect(hint.locationHint).toBe('wnam');
    });
  });

  // -----------------------------------------------------------------------
  // enforceEUResidency
  // -----------------------------------------------------------------------

  describe('enforceEUResidency', () => {
    it('should enforce EU residency for EU users', () => {
      const request = createRequestWithCountry('DE');
      const context = enforceEUResidency(request);

      expect(context.enforceEU).toBe(true);
      expect(context.regionInfo.isEU).toBe(true);
      expect(context.locationHint.locationHint).toBe('weur');
    });

    it('should not enforce EU residency for US users', () => {
      const request = createRequestWithCountry('US');
      const context = enforceEUResidency(request);

      expect(context.enforceEU).toBe(false);
      expect(context.regionInfo.isEU).toBe(false);
    });

    it('should not enforce for unknown regions', () => {
      const request = createRequestWithCountry(null);
      const context = enforceEUResidency(request);

      expect(context.enforceEU).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // addResidencyHeaders
  // -----------------------------------------------------------------------

  describe('addResidencyHeaders', () => {
    it('should add data region header for EU users', () => {
      const response = new Response('{}', { status: 200 });
      const context = enforceEUResidency(createRequestWithCountry('FR'));
      const augmented = addResidencyHeaders(response, context);

      expect(augmented.headers.get('X-Data-Region')).toBe('eu');
      expect(augmented.headers.get('X-Detected-Country')).toBe('FR');
      expect(augmented.headers.get('X-EU-Residency')).toBe('enforced');
    });

    it('should add data region header for non-EU users', () => {
      const response = new Response('{}', { status: 200 });
      const context = enforceEUResidency(createRequestWithCountry('US'));
      const augmented = addResidencyHeaders(response, context);

      expect(augmented.headers.get('X-Data-Region')).toBe('non-eu');
      expect(augmented.headers.get('X-Detected-Country')).toBe('US');
      expect(augmented.headers.get('X-EU-Residency')).toBeNull();
    });

    it('should handle unknown region', () => {
      const response = new Response('{}', { status: 200 });
      const context = enforceEUResidency(createRequestWithCountry(null));
      const augmented = addResidencyHeaders(response, context);

      expect(augmented.headers.get('X-Data-Region')).toBe('unknown');
      expect(augmented.headers.get('X-Detected-Country')).toBeNull();
    });

    it('should preserve original response status', () => {
      const response = new Response('{}', { status: 201 });
      const context = enforceEUResidency(createRequestWithCountry('DE'));
      const augmented = addResidencyHeaders(response, context);

      expect(augmented.status).toBe(201);
    });
  });

  // -----------------------------------------------------------------------
  // EU_COUNTRY_CODES
  // -----------------------------------------------------------------------

  describe('EU_COUNTRY_CODES', () => {
    it('should contain all 27 EU member states', () => {
      const eu27 = [
        'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
        'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
        'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
      ];
      for (const code of eu27) {
        expect(EU_COUNTRY_CODES.has(code)).toBe(true);
      }
    });

    it('should contain EEA countries', () => {
      expect(EU_COUNTRY_CODES.has('IS')).toBe(true);
      expect(EU_COUNTRY_CODES.has('LI')).toBe(true);
      expect(EU_COUNTRY_CODES.has('NO')).toBe(true);
    });

    it('should not contain non-EU countries', () => {
      expect(EU_COUNTRY_CODES.has('US')).toBe(false);
      expect(EU_COUNTRY_CODES.has('CN')).toBe(false);
      expect(EU_COUNTRY_CODES.has('RU')).toBe(false);
    });
  });
});
